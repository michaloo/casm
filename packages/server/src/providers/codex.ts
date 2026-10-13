// Codex via `codex app-server`: JSON-RPC over stdio, one process per open
// session. The native session id is the thread id; history comes from
// `thread/items/list`, which reads Codex's own rollout files.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { Answers, AnswerValue, Catalog, Item, ModeInfo, ModelInfo, PermissionRequest, QuestionPrompt, QuestionRequest } from "@casm/protocol";
import type { OpenOptions, PermissionAnswer, Provider, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;
const CLIENT_INFO = { name: "casm", title: "casm", version: "0.0.1" };

// --- normalization (shared by history and live events)

export type CodexItem = { type: string; id?: string; [k: string]: unknown };
type ToolItem = Extract<Item, { kind: "tool" }>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : text;
}

function toolStatus(status: unknown, live: boolean): ToolItem["status"] {
  if (status === "inProgress") return "running";
  if (status === "failed" || status === "declined") return "error";
  if (status === undefined) return live ? "running" : "done";
  return "done";
}

// `/bin/bash -lc 'ls -la'` -> `ls -la`
export function unwrapShell(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -lc ([\s\S]*)$/.exec(command);
  if (!m) return command;
  const rest = m[1];
  if (/^'[^']*'$/.test(rest)) return rest.slice(1, -1);
  return /^[^'"\s]+$/.test(rest) ? rest : command;
}

function contentText(items: unknown): string {
  return arr(items)
    .map((c) => {
      const b = rec(c);
      if (b.type === "text" || b.type === "inputText") return str(b.text);
      return `[${str(b.type)}]`;
    })
    .join("\n");
}

function tool(item: CodexItem, name: string, input: unknown, status: ToolItem["status"], output?: string): ToolItem {
  const t: ToolItem = { kind: "tool", id: str(item.id), name, input, status };
  if (output) t.output = truncate(output);
  return t;
}

// One Codex ThreadItem -> one casm Item. `live` marks an item/started snapshot.
export function normalize(item: CodexItem, live = false): Item | null {
  const id = str(item.id);
  const status = toolStatus(item.status, live);
  switch (item.type) {
    case "userMessage": {
      const text = arr(item.content)
        .map((c) => {
          const b = rec(c);
          if (b.type === "text") return str(b.text);
          if (b.type === "mention" || b.type === "skill") return `@${str(b.name)}`;
          return `[${str(b.type)}]`;
        })
        .join("\n")
        .trim();
      return text ? { kind: "user", id: str(item.clientId) || id, text } : null;
    }
    case "agentMessage":
    case "plan":
      return str(item.text).trim() ? { kind: "assistant", id, text: str(item.text) } : null;
    case "reasoning": {
      const parts = arr(item.summary).length ? arr(item.summary) : arr(item.content);
      const text = parts.map(str).join("\n\n");
      return text.trim() ? { kind: "reasoning", id, text } : null;
    }
    case "commandExecution": {
      let output = str(item.aggregatedOutput);
      if (item.status === "declined" && !output) output = "Declined by the user.";
      return tool(item, "shell", { command: unwrapShell(str(item.command)), cwd: item.cwd }, status, output);
    }
    case "fileChange": {
      const changes = arr(item.changes).map(rec);
      const input = { changes: changes.map((c) => ({ path: str(c.path), kind: str(rec(c.kind).type || c.kind) })) };
      const output = item.status === "declined" ? "Declined by the user." : changes.map((c) => `${str(c.path)}\n${str(c.diff)}`).join("\n");
      return tool(item, "edit", input, status, output);
    }
    case "mcpToolCall": {
      const output = item.error ? str(rec(item.error).message) : item.result ? contentText(rec(item.result).content) : "";
      return tool(item, `mcp__${str(item.server)}__${str(item.tool)}`, item.arguments, status, output);
    }
    case "dynamicToolCall":
      return tool(item, str(item.tool), item.arguments, status, contentText(item.contentItems));
    case "collabAgentToolCall": {
      const states = rec(item.agentsStates);
      const output = Object.keys(states).length ? JSON.stringify(states) : "";
      return tool(item, `agent.${str(item.tool)}`, { prompt: item.prompt, model: item.model, receivers: item.receiverThreadIds }, status, output);
    }
    case "functionCallOutput":
      return tool(item, str(item.name) || "tool", undefined, "done", typeof item.output === "string" ? item.output : contentText(item.output));
    case "webSearch":
      return tool(item, "web_search", { query: item.query, action: item.action }, status);
    case "imageView":
      return tool(item, "view_image", { path: item.path }, status);
    case "contextCompaction":
      return { kind: "notice", id, text: "Context compacted" };
    case "subAgentActivity":
      return { kind: "notice", id, text: `Subagent ${str(item.agentPath)} ${str(item.kind)}` };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { kind: "notice", id, text: `${item.type === "enteredReviewMode" ? "Review started" : "Review finished"}: ${str(item.review)}` };
    case "hookPrompt":
      return null;
    default: {
      const { type, id: _id, status: _s, ...rest } = item;
      return tool(item, type, rest, status);
    }
  }
}

// --- JSON-RPC over stdio (newline-delimited, no "jsonrpc" field)

type Msg = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

class Rpc {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>, id: string) => Promise<unknown> = () => Promise.reject(new Error("unsupported"));
  onExit: (error?: string) => void = () => {};

  constructor(cwd: string, env: Record<string, string>) {
    const bin = process.env.CASM_CODEX_PATH ?? "codex";
    this.child = spawn(bin, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.handle(line));
    let exited = false;
    const exit = (error?: string) => {
      if (exited) return;
      exited = true;
      for (const p of this.pending.values()) p.reject(new Error(error ?? "codex app-server exited"));
      this.pending.clear();
      this.onExit(error);
    };
    this.child.on("error", (e) => exit(e.message));
    this.child.on("exit", (code, signal) =>
      exit(code === 0 || signal ? undefined : `codex app-server exited with ${code}: ${this.stderr.trim().split("\n").pop() ?? ""}`),
    );
    this.child.stdin.on("error", () => {});
  }

  private write(m: Msg) {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(m) + "\n");
  }

  private handle(line: string) {
    let m: Msg;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) {
      const id = m.id;
      this.onRequest(m.method, rec(m.params), String(id)).then(
        (result) => this.write({ id, result }),
        (e: unknown) => this.write({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }),
      );
    } else if (m.method) this.onNotification(m.method, rec(m.params));
    else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result);
    }
  }

  request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ method, params });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }

  kill() {
    if (this.child.exitCode === null) this.child.kill();
  }
}

// --- questions (item/tool/requestUserInput, mcpServer/elicitation/request)

// request_user_input: one prompt per question. Options -> select (with free
// text when isOther), no options -> text.
export function userInputQuestion(p: Record<string, unknown>, id: string): QuestionRequest {
  const prompts = arr(p.questions).map((raw): QuestionPrompt => {
    const q = rec(raw);
    const options = arr(q.options).map((o) => ({ label: str(rec(o).label), description: str(rec(o).description) || undefined }));
    const prompt: QuestionPrompt = { id: str(q.id), text: str(q.question), header: str(q.header) || undefined, kind: options.length ? "select" : "text" };
    if (options.length) {
      prompt.options = options;
      if (q.isOther) prompt.allowOther = true;
    }
    if (q.isSecret) prompt.secret = true;
    return prompt;
  });
  return { id, prompts };
}

const answerList = (v: AnswerValue | undefined): string[] =>
  v === undefined ? [] : typeof v === "boolean" ? [v ? "yes" : "no"] : (Array.isArray(v) ? v : [v]).filter((s) => s !== "");

// Dismissed (null) answers nothing, which Codex reports to the model as skipped.
export function userInputResponse(p: Record<string, unknown>, answers: Answers | null): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  if (!answers) return { answers: out };
  for (const raw of arr(p.questions)) {
    const qid = str(rec(raw).id);
    const list = answerList(answers[qid]);
    if (list.length) out[qid] = { answers: list };
  }
  return { answers: out };
}

type FormField = { key: string; type: "string" | "number" | "integer" | "boolean" | "enum" | "multi"; values?: string[] };
export type ElicitationForm = { req: QuestionRequest; fields: FormField[] };

// A form elicitation's flat schema -> one prompt per property. Null when the
// form has no fields or a field casm cannot render.
export function elicitationQuestion(p: Record<string, unknown>, id: string): ElicitationForm | null {
  if (p.mode === "url") return null;
  const schema = rec(p.requestedSchema);
  const entries = Object.entries(rec(schema.properties));
  if (!entries.length) return null;
  const prompts: QuestionPrompt[] = [];
  const fields: FormField[] = [];
  for (const [key, raw] of entries) {
    const f = rec(raw);
    const title = str(f.title) || key;
    const desc = str(f.description);
    const base = { id: key, text: desc || title, header: desc ? title : undefined };
    const placeholder = f.default === undefined || f.default === null ? undefined : String(f.default);
    const items = rec(f.items);
    const choices = (list: unknown[]) =>
      list.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: str(rec(o).const), label: str(rec(o).title) || str(rec(o).const) }));
    let opts: { value: string; label: string }[] | null = null;
    let multi = false;
    if (f.type === "array") {
      opts = choices(arr(items.anyOf).length ? arr(items.anyOf) : arr(items.enum));
      multi = true;
    } else if (arr(f.oneOf).length) opts = choices(arr(f.oneOf));
    else if (arr(f.enum).length) {
      const names = arr(f.enumNames).map(str);
      opts = arr(f.enum).map((v, i) => ({ value: str(v), label: names[i] || str(v) }));
    }
    if (opts) {
      if (!opts.length) return null;
      prompts.push({ ...base, kind: "select", options: opts.map((o) => ({ label: o.label })), multiple: multi || undefined });
      fields.push({ key, type: multi ? "multi" : "enum", values: opts.map((o) => o.value) });
    } else if (f.type === "boolean") {
      prompts.push({ ...base, kind: "confirm" });
      fields.push({ key, type: "boolean" });
    } else if (f.type === "string" || f.type === "number" || f.type === "integer") {
      prompts.push({ ...base, kind: "text", placeholder });
      fields.push({ key, type: f.type });
    } else return null;
  }
  return { req: { id, title: str(p.message) || undefined, prompts }, fields };
}

export function elicitationResponse(form: ElicitationForm, answers: Answers | null): { action: "accept" | "cancel"; content: Record<string, unknown> | null; _meta: null } {
  if (!answers) return { action: "cancel", content: null, _meta: null };
  const content: Record<string, unknown> = {};
  form.fields.forEach((field, i) => {
    const v = answers[field.key];
    if (v === undefined) return;
    const labels = (form.req.prompts[i].options ?? []).map((o) => o.label);
    const toValue = (label: string) => {
      const at = labels.indexOf(label);
      return at >= 0 && field.values ? field.values[at] : label;
    };
    switch (field.type) {
      case "boolean":
        content[field.key] = typeof v === "boolean" ? v : /^(y|yes|true|1)$/i.test(String(v));
        return;
      case "multi":
        content[field.key] = answerList(v).map(toValue);
        return;
      case "enum": {
        const first = answerList(v)[0];
        if (first !== undefined) content[field.key] = toValue(first);
        return;
      }
      case "number":
      case "integer": {
        const text = answerList(v)[0]?.trim();
        const n = Number(text);
        if (text && Number.isFinite(n)) content[field.key] = field.type === "integer" ? Math.trunc(n) : n;
        return;
      }
      default: {
        const text = answerList(v).join(", ");
        if (text) content[field.key] = text;
      }
    }
  });
  return { action: "accept", content, _meta: null };
}

// --- catalog

export function parseModels(data: unknown[]): ModelInfo[] {
  return data.map(rec).flatMap((m): ModelInfo[] => {
    const id = str(m.model) || str(m.id);
    if (!id || m.hidden === true) return [];
    const info: ModelInfo = { id, name: str(m.displayName) || undefined, description: str(m.description) || undefined, isDefault: m.isDefault === true };
    const efforts = arr(m.supportedReasoningEfforts).map((e) => str(rec(e).reasoningEffort)).filter(Boolean);
    if (efforts.length) info.efforts = efforts;
    return [info];
  });
}

const MODE_INFO: ModeInfo[] = [
  { id: "read-only", name: "Read only", description: "Read-only sandbox; asks before anything else" },
  { id: "auto", name: "Auto", description: "Edits and runs commands in the workspace; asks to go beyond it" },
  { id: "untrusted", name: "Untrusted", description: "Asks before any command that is not known to be safe" },
  { id: "full-access", name: "Full access", description: "No sandbox and no approvals" },
];

export async function readCatalog(): Promise<Catalog> {
  const rpc = new Rpc(homedir(), process.env as Record<string, string>);
  try {
    await rpc.initialize();
    const data: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: unknown[]; nextCursor: string | null } = await rpc.request("model/list", { cursor, includeHidden: false });
      data.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return { models: parseModels(data), modes: MODE_INFO };
  } finally {
    rpc.kill();
  }
}

// --- session

// casm mode -> Codex approval policy + sandbox. Unknown modes keep Codex's own config.
const MODES: Record<string, { approvalPolicy: string; sandbox: string }> = {
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

type Decision = "accept" | "acceptForSession" | "decline" | "cancel" | Record<string, unknown>;

class CodexSession implements ProviderSession {
  private rpc: Rpc;
  private opts: OpenOptions;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private ended = new Set<string>();
  // Serializes startup, turn/start, steer and interrupt.
  private chain: Promise<unknown>;
  private approvals = new Map<string, AbortController>();
  // Tool items seen in this turn, so approvals can show what they approve.
  private tools = new Map<string, Item>();
  private closing = false;

  constructor(opts: OpenOptions) {
    this.opts = opts;
    this.rpc = new Rpc(opts.cwd, { ...(process.env as Record<string, string>), ...opts.config.env });
    this.rpc.onNotification = (m, p) => this.onNotification(m, p);
    this.rpc.onRequest = (m, p, id) => this.onRequest(m, p, id);
    this.rpc.onExit = (error) => {
      this.abortApprovals();
      opts.emit({ type: "closed", error: this.closing ? undefined : error });
    };
    this.chain = this.start().catch((e: unknown) => {
      opts.emit({ type: "closed", error: e instanceof Error ? e.message : String(e) });
      this.closing = true;
      this.rpc.kill();
    });
  }

  private async start() {
    const { cwd, config, resumeId } = this.opts;
    await this.rpc.initialize();
    const mode = config.mode ? MODES[config.mode] : undefined;
    const params = {
      cwd,
      model: config.model,
      approvalPolicy: mode?.approvalPolicy,
      sandbox: mode?.sandbox,
      developerInstructions: config.systemPrompt,
      // request_user_input is otherwise only offered in Plan mode.
      config: { features: { default_mode_request_user_input: true }, ...(config.mcpServers ? { mcp_servers: config.mcpServers } : {}) },
    };
    const res = resumeId
      ? await this.rpc.request<{ thread: { id: string } }>("thread/resume", { ...params, threadId: resumeId, excludeTurns: true })
      : await this.rpc.request<{ thread: { id: string } }>("thread/start", params);
    this.threadId = res.thread.id;
    this.opts.emit({ type: "sessionId", id: res.thread.id });
  }

  private onNotification(method: string, p: Record<string, unknown>) {
    const { emit } = this.opts;
    if (p.threadId !== undefined && p.threadId !== this.threadId) return; // subagent threads
    switch (method) {
      case "turn/started": {
        const id = str(rec(p.turn).id);
        if (!this.ended.has(id)) this.turnId = id;
        return;
      }
      case "item/agentMessage/delta":
        emit({ type: "delta", kind: "assistant", text: str(p.delta) });
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        emit({ type: "delta", kind: "reasoning", text: str(p.delta) });
        return;
      case "item/started":
      case "item/completed": {
        const raw = rec(p.item) as CodexItem;
        if (raw.type === "userMessage") return; // the manager emits our prompts
        const item = normalize(raw, method === "item/started");
        if (!item) return;
        if (item.kind === "tool") this.tools.set(item.id, item);
        // Text arrives as deltas; the full item lands on completion.
        if (method === "item/completed" || item.kind === "tool" || item.kind === "notice") emit({ type: "item", item });
        return;
      }
      case "serverRequest/resolved":
        this.approvals.get(str(p.requestId))?.abort();
        return;
      case "turn/completed": {
        const turn = rec(p.turn);
        const id = str(turn.id);
        this.ended.add(id);
        if (this.turnId === id) this.turnId = null;
        this.abortApprovals();
        const status = str(turn.status);
        for (const t of this.tools.values())
          if (t.kind === "tool" && t.status === "running")
            emit({ type: "item", item: { ...t, status: "error", output: status === "interrupted" ? "Interrupted." : "Did not finish." } });
        this.tools.clear();
        const outcome = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
        const error = outcome === "failed" ? str(rec(turn.error).message) || "turn failed" : undefined;
        emit({ type: "turnEnded", outcome, error });
        return;
      }
    }
  }

  private abortApprovals() {
    for (const c of this.approvals.values()) c.abort();
    this.approvals.clear();
  }

  private async question(rpcId: string, req: QuestionRequest): Promise<Answers | null> {
    const ctrl = new AbortController();
    this.approvals.set(rpcId, ctrl);
    try {
      return await this.opts.askQuestion(req, ctrl.signal);
    } catch {
      return null;
    } finally {
      this.approvals.delete(rpcId);
    }
  }

  private async ask(rpcId: string, req: Omit<PermissionRequest, "id">, itemId: string): Promise<PermissionAnswer | null> {
    const ctrl = new AbortController();
    this.approvals.set(rpcId, ctrl);
    try {
      return await this.opts.askPermission({ ...req, id: itemId || rpcId }, ctrl.signal);
    } catch {
      return null;
    } finally {
      this.approvals.delete(rpcId);
    }
  }

  // `key` is the JSON-RPC id, which `serverRequest/resolved` refers to.
  private async onRequest(method: string, p: Record<string, unknown>, key: string): Promise<unknown> {
    const itemId = str(p.approvalId) || str(p.itemId);
    const reason = str(p.reason) || undefined;
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const available = arr(p.availableDecisions);
        // Only session-scoped "always". Codex's execpolicy amendment would write a
        // permanent rule to ~/.codex/rules, affecting every future session.
        const always: Decision | null = !available.length || available.includes("acceptForSession") ? "acceptForSession" : null;
        const command = unwrapShell(str(p.command));
        const a = await this.ask(key, { toolName: "shell", input: { command, cwd: p.cwd, reason }, title: reason ?? command, canAlwaysAllow: !!always }, itemId);
        return { decision: this.decision(a, always) };
      }
      case "item/fileChange/requestApproval": {
        const known = this.tools.get(str(p.itemId));
        const input = known?.kind === "tool" ? { ...rec(known.input), reason } : { reason };
        const a = await this.ask(key, { toolName: "edit", input, title: reason ?? "Apply file changes", canAlwaysAllow: true }, itemId);
        return { decision: this.decision(a, "acceptForSession") };
      }
      case "item/permissions/requestApproval": {
        const requested = Object.fromEntries(Object.entries(rec(p.permissions)).filter(([, v]) => v != null));
        const a = await this.ask(key, { toolName: "permissions", input: { ...requested, reason }, title: reason ?? "Grant additional permissions", canAlwaysAllow: true }, itemId);
        if (!a || a.decision === "deny") return { permissions: {}, scope: "turn" };
        return { permissions: requested, scope: a.decision === "allowAlways" ? "session" : "turn" };
      }
      case "mcpServer/elicitation/request": {
        if (p.mode === "url") return { action: "decline", content: null, _meta: null };
        const form = elicitationQuestion(p, `elicitation-${randomUUID()}`);
        if (form) return elicitationResponse(form, await this.question(key, form.req));
        if (Object.keys(rec(rec(p.requestedSchema).properties)).length) return { action: "decline", content: null, _meta: null };
        const a = await this.ask(key, { toolName: `mcp__${str(p.serverName)}`, input: { message: p.message }, title: str(p.message), canAlwaysAllow: false }, str(p.elicitationId));
        return { action: a && a.decision !== "deny" ? "accept" : "decline", content: a && a.decision !== "deny" ? {} : null, _meta: null };
      }
      case "item/tool/requestUserInput":
        return userInputResponse(p, await this.question(key, userInputQuestion(p, str(p.itemId) || `input-${randomUUID()}`)));
      default:
        throw new Error(`casm does not handle ${method}`);
    }
  }

  private decision(a: PermissionAnswer | null, always: Decision | null): Decision {
    if (!a) return "cancel";
    if (a.decision === "deny") return "decline";
    return a.decision === "allowAlways" && always ? always : "accept";
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e: unknown) => {
      this.opts.emit({ type: "turnEnded", outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return this.chain;
  }

  send(text: string, itemId: string) {
    void this.enqueue(async () => {
      if (!this.threadId) return; // startup failed; `closed` was emitted
      const input = [{ type: "text", text, text_elements: [] }];
      if (this.turnId) {
        try {
          await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input, clientUserMessageId: itemId });
          return;
        } catch {
          // The turn ended in between: start a new one instead.
        }
      }
      const { config } = this.opts;
      const res = await this.rpc.request<{ turn: { id: string; status: string } }>("turn/start", {
        threadId: this.threadId,
        input,
        clientUserMessageId: itemId,
        model: config.model,
        effort: config.effort,
      });
      if (res.turn.status === "inProgress" && !this.ended.has(res.turn.id)) this.turnId = res.turn.id;
    });
  }

  async interrupt() {
    await this.enqueue(async () => {
      if (!this.threadId || !this.turnId) return;
      await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    });
  }

  async close() {
    this.closing = true;
    this.abortApprovals();
    this.rpc.kill();
  }
}

export async function readHistory(sessionId: string, cwd: string): Promise<Item[]> {
  const rpc = new Rpc(cwd, process.env as Record<string, string>);
  try {
    await rpc.initialize();
    const byId = new Map<string, Item>();
    let cursor: string | null = null;
    do {
      const page: { data: { item: CodexItem }[]; nextCursor: string | null } = await rpc.request("thread/items/list", {
        threadId: sessionId,
        cursor,
        limit: 500,
      });
      for (const { item } of page.data) {
        const it = normalize(item);
        if (it) byId.set(it.id, it);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return [...byId.values()];
  } finally {
    rpc.kill();
  }
}

export function codexProvider(): Provider {
  return {
    id: "codex",
    open: (opts) => new CodexSession(opts),
    history: readHistory,
    catalog: readCatalog,
  };
}

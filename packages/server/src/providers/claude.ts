// Claude Code via the Claude Agent SDK: one long-lived query() per open
// session, fed by an async input queue. History comes from Claude's own JSONL.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  query,
  getSessionMessages,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type ModelInfo as SdkModelInfo,
  type OnElicitation,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Answers, AnswerValue, Catalog, Item, ModeInfo, ModelInfo, QuestionPrompt, QuestionRequest } from "@casm/protocol";
import type { OpenOptions, Provider, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;
const CATALOG_TIMEOUT_MS = 30_000;
// supportedModels() lists this pseudo-model first; open() passes no model for it.
const DEFAULT_MODEL = "default";

// --- normalization (shared by history and live events)

type Block = { type: string; [k: string]: unknown };

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function toolOutput(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : blocks(content)
          .map((b) => (b.type === "text" ? String(b.text) : `[${b.type}]`))
          .join("\n");
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : text;
}

// Turns one transcript message into items. `tools` carries tool_use items across
// messages so a later tool_result can complete them; completed tools are
// returned again so callers can upsert.
export function normalize(
  msg: { type: string; uuid?: string; message?: unknown },
  tools: Map<string, Extract<Item, { kind: "tool" }>>,
): Item[] {
  const m = msg.message as { role?: string; content?: unknown } | undefined;
  if (!m || !msg.uuid) return [];
  const out: Item[] = [];
  const bs = blocks(m.content);

  if (msg.type === "assistant") {
    bs.forEach((b, i) => {
      const id = `${msg.uuid}:${i}`;
      if (b.type === "text" && String(b.text).trim()) out.push({ kind: "assistant", id, text: String(b.text) });
      else if (b.type === "thinking" && String(b.thinking ?? "").trim())
        out.push({ kind: "reasoning", id, text: String(b.thinking) });
      else if (b.type === "tool_use") {
        const item = { kind: "tool" as const, id: String(b.id), name: String(b.name), input: b.input, status: "running" as const };
        tools.set(item.id, item);
        out.push(item);
      }
    });
  } else if (msg.type === "user") {
    const texts: string[] = [];
    for (const b of bs) {
      if (b.type === "text") texts.push(String(b.text));
      else if (b.type === "image") texts.push("[image]");
      else if (b.type === "tool_result") {
        const id = String(b.tool_use_id);
        const prev = tools.get(id);
        const done: Extract<Item, { kind: "tool" }> = {
          kind: "tool",
          id,
          name: prev?.name ?? "tool",
          input: prev?.input,
          status: b.is_error ? "error" : "done",
          output: toolOutput(b.content),
        };
        tools.set(id, done);
        out.push(done);
      }
    }
    const text = texts.join("\n").trim();
    // Claude records interrupts as a synthetic user message.
    if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) out.unshift({ kind: "notice", id: msg.uuid, text: "Interrupted" });
    else if (text) out.unshift({ kind: "user", id: msg.uuid, text });
  }
  return out;
}

// --- questions: AskUserQuestion and MCP elicitations

// AskUserQuestionInput in sdk-tools.d.ts, loosened since tool input is untrusted.
type AskQuestion = {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
};

// One prompt per question; prompt ids are the question index.
export function askUserQuestionRequest(id: string, input: { questions?: AskQuestion[] }): QuestionRequest {
  const questions = input.questions ?? [];
  return {
    id,
    prompts: questions.map((q, i) => ({
      id: `q${i}`,
      text: q.question,
      header: q.header || undefined,
      kind: "select",
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || undefined })),
      multiple: q.multiSelect || undefined,
      // Claude always offers a free-text "Other" answer.
      allowOther: true,
    })),
  };
}

function answerText(v: AnswerValue): string {
  return Array.isArray(v) ? v.join(", ") : String(v);
}

// The tool expects answers keyed by question text; multi-select answers are comma-separated.
export function askUserQuestionInput(
  input: { questions?: AskQuestion[] },
  answers: Answers,
): { questions?: AskQuestion[]; answers: Record<string, string> } {
  const out: Record<string, string> = {};
  (input.questions ?? []).forEach((q, i) => {
    const v = answers[`q${i}`];
    if (v !== undefined && answerText(v) !== "") out[q.question] = answerText(v);
  });
  return { ...input, answers: out };
}

type SchemaProp = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: { const?: unknown; title?: string }[];
  items?: { enum?: unknown[]; anyOf?: { const?: unknown; title?: string }[] };
  default?: unknown;
};

function schemaProps(req: ElicitationRequest): [string, SchemaProp][] {
  const props = (req.requestedSchema?.properties ?? {}) as Record<string, SchemaProp>;
  return Object.entries(props);
}

function choices(p: SchemaProp): { label: string; description?: string }[] | undefined {
  if (p.oneOf) return p.oneOf.map((o) => ({ label: String(o.const), description: o.title }));
  if (p.enum) return p.enum.map((v, i) => ({ label: String(v), description: p.enumNames?.[i] }));
  if (p.items?.anyOf) return p.items.anyOf.map((o) => ({ label: String(o.const), description: o.title }));
  if (p.items?.enum) return p.items.enum.map((v) => ({ label: String(v) }));
  return undefined;
}

// Form mode: one prompt per top-level schema property (prompt id = property name).
// URL mode: one confirm prompt; confirming means the user finished in the browser.
export function elicitationRequest(id: string, req: ElicitationRequest): QuestionRequest {
  const title = req.title ?? req.displayName ?? req.serverName;
  if (req.mode === "url")
    return { id, title, prompts: [{ id: "url", kind: "confirm", text: `${req.message}\n${req.url ?? ""}`.trim() }] };
  const required = new Set((req.requestedSchema?.required as string[] | undefined) ?? []);
  const prompts: QuestionPrompt[] = schemaProps(req).map(([key, p]) => {
    const text = [p.title ?? key, p.description].filter(Boolean).join(": ") + (required.has(key) ? "" : " (optional)");
    const options = choices(p);
    if (p.type === "boolean") return { id: key, kind: "confirm", text };
    if (options) return { id: key, kind: "select", text, options, multiple: p.type === "array" || undefined };
    return { id: key, kind: "text", text, placeholder: p.default === undefined ? undefined : String(p.default) };
  });
  if (!prompts.length) return { id, title, prompts: [{ id: "confirm", kind: "confirm", text: req.message }] };
  return { id, title: `${title}: ${req.message}`, prompts };
}

export function elicitationResult(req: ElicitationRequest, answers: Answers | null): ElicitationResult {
  if (!answers) return { action: "decline" };
  if (req.mode === "url") return { action: answers.url === false ? "decline" : "accept" };
  const props = schemaProps(req);
  if (!props.length) return { action: answers.confirm === false ? "decline" : "accept" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, p] of props) {
    const v = answers[key];
    if (v === undefined || v === "") continue;
    if (p.type === "boolean") content[key] = v === true || v === "true";
    else if (p.type === "number" || p.type === "integer") {
      const n = Number(answerText(v));
      if (Number.isFinite(n)) content[key] = p.type === "integer" ? Math.trunc(n) : n;
    } else if (p.type === "array") content[key] = Array.isArray(v) ? v : [String(v)];
    else content[key] = answerText(v);
  }
  return { action: "accept", content };
}

// --- catalog

const MODES: (ModeInfo & { id: PermissionMode })[] = [
  { id: "default", name: "Default", description: "Ask before edits and commands" },
  { id: "acceptEdits", name: "Accept edits", description: "Edit files without asking; ask for commands" },
  { id: "plan", name: "Plan", description: "Read-only planning; ask before leaving plan mode" },
  { id: "auto", name: "Auto", description: "A classifier approves safe actions; asks when unsure" },
  { id: "dontAsk", name: "Don't ask", description: "Deny anything not pre-approved" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Run every tool without asking" },
];

export function parseCatalog(models: SdkModelInfo[]): Catalog {
  return {
    models: models.map(
      (m): ModelInfo => ({
        id: m.value,
        name: m.displayName,
        description: m.description || undefined,
        isDefault: m.value === DEFAULT_MODEL || undefined,
        efforts: m.supportedEffortLevels?.length ? [...m.supportedEffortLevels] : undefined,
      }),
    ),
    modes: MODES.filter((mode) => mode.id !== "auto" || models.some((m) => m.supportsAutoMode)),
  };
}

// --- input queue for streaming-input mode

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  push(m: SDKUserMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.buf.push(m);
  }

  end() {
    this.done = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.buf.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

function findClaude(): string | undefined {
  if (process.env.CASM_CLAUDE_PATH) return process.env.CASM_CLAUDE_PATH;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

class ClaudeSession implements ProviderSession {
  private input = new InputQueue();
  private q: ReturnType<typeof query>;
  private tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  private interrupted = false;
  private opts: OpenOptions;

  constructor(opts: OpenOptions, executable: string | undefined) {
    this.opts = opts;
    const { cwd, config, resumeId } = opts;
    const options: Options = {
      cwd,
      resume: resumeId ?? undefined,
      model: config.model === DEFAULT_MODEL ? undefined : config.model,
      permissionMode: config.mode as PermissionMode | undefined,
      // bypassPermissions is refused without this; only set it when that mode was chosen.
      allowDangerouslySkipPermissions: config.mode === "bypassPermissions" || undefined,
      effort: config.effort as Options["effort"],
      systemPrompt: { type: "preset", preset: "claude_code", append: config.systemPrompt },
      mcpServers: config.mcpServers as Options["mcpServers"],
      env: { ...(process.env as Record<string, string>), ...config.env },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: executable,
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  private canUseTool: CanUseTool = async (toolName, input, o) => {
    if (toolName === "AskUserQuestion") return this.askUserQuestion(input, o.toolUseID ?? randomUUID(), o.signal);
    const answer = await this.opts.askPermission(
      {
        id: o.toolUseID ?? randomUUID(),
        toolName,
        input,
        title: o.title ?? o.description,
        canAlwaysAllow: !!o.suggestions?.length,
      },
      o.signal,
    );
    if (answer.decision === "deny") return { behavior: "deny", message: answer.message || "Denied by the user." };
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: answer.decision === "allowAlways" ? o.suggestions : undefined,
    };
  };

  private async askUserQuestion(input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<PermissionResult> {
    const questions = input as { questions?: AskQuestion[] };
    let answers: Answers | null;
    try {
      answers = await this.opts.askQuestion(askUserQuestionRequest(id, questions), signal);
    } catch {
      return { behavior: "deny", message: "The question was cancelled.", interrupt: true };
    }
    if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering." };
    return { behavior: "allow", updatedInput: { ...askUserQuestionInput(questions, answers) } };
  }

  private onElicitation: OnElicitation = async (req, o) => {
    try {
      return elicitationResult(req, await this.opts.askQuestion(elicitationRequest(o.requestId || randomUUID(), req), o.signal));
    } catch {
      return { action: "cancel" };
    }
  };

  private async pump() {
    const { emit } = this.opts;
    try {
      for await (const m of this.q) this.handle(m);
      emit({ type: "closed" });
    } catch (e) {
      emit({ type: "closed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private handle(m: SDKMessage) {
    const { emit } = this.opts;
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return; // subagent internals
    switch (m.type) {
      case "system":
        if (m.subtype === "init") emit({ type: "sessionId", id: m.session_id });
        return;
      case "conversation_reset":
        // /clear or leaving plan mode moves Claude to a new transcript.
        emit({ type: "sessionId", id: m.new_conversation_id });
        emit({ type: "item", item: { kind: "notice", id: m.uuid, text: `Conversation reset${m.trigger ? ` (${m.trigger})` : ""}` } });
        return;
      case "stream_event": {
        const ev = m.event;
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") emit({ type: "delta", kind: "assistant", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta" && ev.delta.thinking.trim())
            emit({ type: "delta", kind: "reasoning", text: ev.delta.thinking });
        }
        return;
      }
      case "assistant":
      case "user":
        // Our own prompts are emitted by the manager when sent.
        if (m.type === "user" && !blocks(m.message.content).some((b) => b.type === "tool_result")) return;
        for (const item of normalize(m, this.tools)) emit({ type: "item", item });
        return;
      case "result": {
        const interrupted = this.interrupted;
        this.interrupted = false;
        if (m.subtype === "success") emit({ type: "turnEnded", outcome: m.is_error ? "failed" : "completed", error: m.is_error ? m.result : undefined });
        else emit({ type: "turnEnded", outcome: interrupted ? "interrupted" : "failed", error: interrupted ? undefined : (m.errors ?? []).join("; ") || m.subtype });
        return;
      }
    }
  }

  send(text: string, itemId: string) {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: itemId as SDKUserMessage["uuid"],
    });
  }

  async interrupt() {
    this.interrupted = true;
    await this.q.interrupt();
  }

  async close() {
    this.input.end();
    this.q.close();
  }
}

// A short-lived query whose input never yields: it initializes, answers
// supportedModels() and is closed without starting a session.
async function fetchCatalog(executable: string | undefined): Promise<Catalog> {
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
  };
  const q = query({ prompt: idle, options: { cwd: homedir(), pathToClaudeCodeExecutable: executable, env: process.env as Record<string, string> } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("claude did not report its models in time")), CATALOG_TIMEOUT_MS);
    });
    return parseCatalog(await Promise.race([q.supportedModels(), timeout]));
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

export function claudeProvider(): Provider {
  const executable = findClaude();
  return {
    id: "claude",
    open: (opts) => new ClaudeSession(opts, executable),
    catalog: () => fetchCatalog(executable),
    async history(sessionId, cwd) {
      const messages = await getSessionMessages(sessionId, { dir: cwd });
      const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
      const byId = new Map<string, Item>();
      for (const m of messages) {
        if (m.parent_tool_use_id) continue;
        // A tool result replaces its call in place.
        for (const item of normalize(m, tools)) byId.set(item.id, item);
      }
      return [...byId.values()];
    },
  };
}

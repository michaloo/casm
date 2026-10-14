import { toolImages } from "./tool-images.ts";
// OpenCode via one shared `opencode serve` per provider: HTTP API for sessions,
// prompts and permission replies, one /global/event SSE stream routed by session.
// Account limits are unavailable: GET /doc exposes no provider quota endpoint.
// History comes from the server's `session/:id/message`.
//
// Images are sent as `file` parts with data URLs. The todo list (todowrite
// tool, todo.updated) becomes one Item.plan per turn, keyed by the turn's user
// message. Retries (session.status retry, retry parts), compaction parts and
// message errors become notices. "/name args" for a known command (GET
// /command, which also lists skills) runs through POST /session/:id/command.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import type { Answers, Catalog, Command, ImageData, Item, PlanEntry, QuestionRequest, Usage } from "@casm/protocol";
import type { OpenOptions, Provider, ProviderEvent, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;
// History drops image data above this many base64 characters (~1 MB decoded).
const MAX_HISTORY_IMAGE = 1_400_000;
// Keep an unused server around briefly so a reload or history read doesn't respawn it.
const IDLE_SHUTDOWN_MS = 30_000;

// --- wire shapes (the subset we read)

type ToolState = {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  attachments?: OcPart[];
  error?: string;
  // Running bash tools carry the output so far in metadata.output.
  metadata?: { output?: unknown; todos?: unknown; sessionId?: string };
};

export type OcPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start?: number; end?: number };
  tool?: string;
  callID?: string;
  state?: ToolState;
  // file parts
  mime?: string;
  filename?: string;
  url?: string;
  // retry parts
  attempt?: number;
  error?: OcError;
  // compaction parts
  auto?: boolean;
  overflow?: boolean;
};

type OcError = { name?: string; data?: { message?: string } };

export type OcTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };

export type OcMessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  error?: OcError;
  // assistant only
  parentID?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: OcTokens;
  summary?: unknown;
};

export type OcMessage = { info: OcMessageInfo; parts: OcPart[] };

export type OcTodo = { content: string; status: string; priority?: string };

export type OcCommand = { name: string; description?: string; source?: string; hints?: string[] };

type OcPermission = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
};

export type OcQuestion = {
  id: string;
  sessionID: string;
  questions: {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
};

export type OcProviders = {
  providers: {
    id: string;
    name?: string;
    models: Record<string, { id?: string; name?: string; status?: string; variants?: Record<string, unknown>; limit?: { context?: number } }>;
  }[];
  default: Record<string, string>;
};

export type OcAgent = { name: string; description?: string; mode?: string; hidden?: boolean };

type OcEvent = { type: string; properties: Record<string, unknown> };

// --- normalization (shared by history and live events)

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : text;
}

// The todo list as plan entries; cancelled items count as done.
export function planEntries(todos: OcTodo[]): PlanEntry[] {
  return todos.map((t) => ({
    text: t.status === "cancelled" ? `${t.content} (cancelled)` : t.content,
    status: t.status === "in_progress" || t.status === "completed" ? t.status : t.status === "cancelled" ? "completed" : "pending",
  }));
}

// One plan per turn, updated in place.
export const planId = (userMessageId: string) => `${userMessageId}:plan`;
export const retryId = (userMessageId: string) => `${userMessageId}:retry`;

function errorItem(messageId: string, e: OcError): Item {
  return { kind: "notice", id: `${messageId}:error`, text: errorText(e), level: "error" };
}

// POST /session/:id/shell stores a user message with only this synthetic text,
// then an assistant message with one bash tool part that runs the command.
export const SHELL_MARKER = "The following tool was executed by the user";
const ABORTED = /\n*<metadata>\nUser aborted the command\n<\/metadata>$/;

// A user shell command's tool item. OpenCode reports no exit code; an aborted
// command completes with a marker, which becomes an error status.
export function shellTool(item: Extract<Item, { kind: "tool" }>): Item {
  const command = (item.input as { command?: unknown } | undefined)?.command;
  const out: Extract<Item, { kind: "tool" }> = { ...item, name: "shell", origin: "user", input: { command: typeof command === "string" ? command : "" } };
  if (out.output !== undefined && ABORTED.test(out.output)) {
    out.output = out.output.replace(ABORTED, "");
    out.status = "error";
  }
  return out;
}

// One assistant part as an item, or null when there is nothing to show yet.
// `turn` is the user message the part answers (assistant info.parentID).
export function normalizePart(p: OcPart, turn?: string): Item | null {
  if (p.type === "retry")
    return { kind: "notice", id: retryId(turn ?? p.messageID), text: `Retry attempt ${p.attempt ?? "?"}: ${errorText(p.error)}`, level: "warning" };
  if (p.type === "compaction")
    return { kind: "notice", id: p.id, text: `Context compacted${p.overflow ? " (context overflow)" : p.auto ? " (auto)" : ""}`, level: "info" };
  if (p.type === "tool" && p.tool === "todowrite" && p.state?.status === "completed") {
    const todos = (p.state.metadata?.todos ?? (p.state.input as { todos?: unknown } | undefined)?.todos) as OcTodo[] | undefined;
    if (Array.isArray(todos)) return { kind: "plan", id: planId(turn ?? p.messageID), entries: planEntries(todos) };
  }
  if (p.type === "text" && !p.synthetic && !p.ignored && p.text?.trim()) return { kind: "assistant", id: p.id, text: p.text };
  if (p.type === "reasoning" && p.text?.trim()) return { kind: "reasoning", id: p.id, text: p.text };
  if (p.type === "tool" && p.tool === "task" && p.state) {
    const s = p.state;
    const input = s.input as { description?: string; subagent_type?: string } | undefined;
    return {
      kind: "subagent", id: p.id, title: input?.description || "Task",
      ...(input?.subagent_type ? { agentType: input.subagent_type } : {}),
      status: s.status === "completed" ? "done" : s.status === "error" ? "error" : "running",
      ...(s.status === "completed" ? { summary: truncate(s.output ?? "") } : s.status === "error" ? { summary: truncate(s.error ?? "") } : {}),
    };
  }
  if (p.type === "tool" && p.state) {
    const s = p.state;
    const base = { kind: "tool" as const, id: p.id, name: p.tool ?? "tool", input: s.input };
    if (s.status === "completed") return { ...base, status: "done", output: truncate(s.output ?? ""), ...toolImages(s.attachments) };
    if (s.status === "error") return { ...base, status: "error", output: truncate(s.error ?? "") };
    return { ...base, status: "running" };
  }
  return null;
}

// Image attachments of a user message. Non-image files (@-mentioned text
// files) are dropped; their content is a synthetic text part.
function userImages(parts: OcPart[]): ImageData[] {
  return parts
    .filter((p) => p.type === "file" && p.mime?.startsWith("image/"))
    .map((p) => {
      const m = /^data:[^;,]*;base64,(.*)$/s.exec(p.url ?? "");
      const data = m && m[1].length <= MAX_HISTORY_IMAGE ? m[1] : undefined;
      return { mediaType: p.mime!, ...(data ? { data } : {}) };
    });
}

export function normalizeMessages(messages: OcMessage[]): Item[] {
  const out: Item[] = [];
  // Repeated items (a turn's plan or retry notice) stay at their first position with the latest content.
  const at = new Map<string, number>();
  const push = (item: Item) => {
    const i = at.get(item.id);
    if (i === undefined) at.set(item.id, out.push(item) - 1);
    else out[i] = item;
  };
  const shellTurns = new Set<string>();
  for (const m of messages) {
    if (m.info.role === "user") {
      if (m.parts.some((p) => p.type === "text" && p.synthetic && p.text === SHELL_MARKER)) shellTurns.add(m.info.id);
      const text = m.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      const images = userImages(m.parts);
      if (text || images.length) push({ kind: "user", id: m.info.id, text, ...(images.length ? { images } : {}) });
      for (const p of m.parts) if (p.type === "compaction") push(normalizePart(p)!);
      continue;
    }
    const shell = shellTurns.has(m.info.parentID ?? "");
    for (const p of m.parts) {
      const item = normalizePart(p, m.info.parentID);
      if (item) push(shell && item.kind === "tool" ? shellTool(item) : item);
    }
    if (m.info.error && m.info.error.name !== "MessageAbortedError") push(errorItem(m.info.id, m.info.error));
  }
  return out;
}

// --- usage

// Tokens of the prompt the model last saw, as cass counts them.
const promptTokens = (t: OcTokens) => (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);

// Session usage from its assistant messages: context of the latest one that
// reported tokens, input/output/cost totals over all of them.
export function sessionUsage(infos: OcMessageInfo[], contextWindow?: (model: string) => number | undefined): Usage | null {
  let input = 0;
  let output = 0;
  let cost = 0;
  let last: OcMessageInfo | undefined;
  for (const i of infos) {
    if (i.role !== "assistant" || !i.tokens) continue;
    input += promptTokens(i.tokens);
    output += (i.tokens.output ?? 0) + (i.tokens.reasoning ?? 0);
    cost += i.cost ?? 0;
    if (promptTokens(i.tokens) > 0 && (!last || i.id > last.id)) last = i;
  }
  if (!last) return null;
  const model = last.providerID && last.modelID ? `${last.providerID}/${last.modelID}` : undefined;
  const window = model ? contextWindow?.(model) : undefined;
  return {
    ...(model ? { model } : {}),
    contextTokens: promptTokens(last.tokens!),
    ...(window ? { contextWindow: window } : {}),
    inputTokens: input,
    outputTokens: output,
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}

// --- commands

export function parseCommands(list: OcCommand[]): Command[] {
  return list.map((c) => {
    // hints are the template's placeholders: $ARGUMENTS or $1, $2, ...
    const hint = (c.hints ?? []).map((h) => (h === "$ARGUMENTS" ? "[arguments]" : `<${h.replace(/^\$/, "arg")}>`)).join(" ");
    return {
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(hint ? { argumentHint: hint } : {}),
      kind: c.source === "skill" ? ("skill" as const) : ("command" as const),
    };
  });
}

// "/name args" -> { name, args }, or null for other text.
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

// Prompt parts for images.
export function imageParts(images: ImageData[] | undefined) {
  return (images ?? [])
    .filter((i) => i.data)
    .map((i, n) => ({
      type: "file" as const,
      mime: i.mediaType,
      filename: `image-${n + 1}.${i.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`,
      url: `data:${i.mediaType};base64,${i.data}`,
    }));
}

// The part of a cumulative tool output snapshot not yet streamed.
export function outputDelta(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length);
  const tail = prev.slice(-200);
  const i = tail ? next.lastIndexOf(tail) : -1;
  return i >= 0 ? next.slice(i + tail.length) : next;
}

function errorText(e: OcError | undefined): string {
  return e?.data?.message || e?.name || "unknown error";
}

// --- questions: one prompt per native question; the reply is one label list per question, in order

export function questionRequest(q: OcQuestion): QuestionRequest {
  return {
    id: q.id,
    prompts: q.questions.map((x, i) => {
      const options = (x.options ?? []).map((o) => (o.description ? o : { label: o.label }));
      const base = { id: `q${i}`, text: x.question, header: x.header || undefined };
      if (!options.length) return { ...base, kind: "text" as const };
      // OpenCode allows a typed answer unless the question sets custom: false.
      return { ...base, kind: "select" as const, options, multiple: x.multiple === true, allowOther: x.custom !== false };
    }),
  };
}

export function questionReply(q: OcQuestion, answers: Answers): string[][] {
  return q.questions.map((_, i) => {
    const v = answers[`q${i}`];
    if (Array.isArray(v)) return v.filter((s) => s.trim());
    if (typeof v === "boolean") return [v ? "Yes" : "No"];
    return v?.trim() ? [v.trim()] : [];
  });
}

// --- catalog

export function parseCatalog(providers: OcProviders, agents: OcAgent[], configModel: string | undefined): Catalog {
  const first = providers.providers.find((p) => providers.default[p.id]);
  const defaultModel = configModel ?? (first ? `${first.id}/${providers.default[first.id]}` : undefined);
  const models = providers.providers.flatMap((p) =>
    Object.entries(p.models)
      .filter(([, m]) => m.status !== "deprecated")
      .map(([key, m]) => {
        const id = `${p.id}/${key}`;
        const efforts = Object.keys(m.variants ?? {});
        return {
          id,
          name: m.name ?? key,
          description: p.name ?? p.id,
          ...(id === defaultModel ? { isDefault: true } : {}),
          ...(efforts.length ? { efforts } : {}),
        };
      }),
  );
  const modes = agents
    .filter((a) => (a.mode === "primary" || a.mode === "all") && a.hidden !== true)
    .map((a) => ({ id: a.name, ...(a.description ? { description: a.description } : {}) }));
  return { models, modes };
}

// --- shared server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

type Listener = { onEvent: (e: OcEvent) => void; onClosed: (error: string) => void };

export class OpencodeServer {
  private parents = new Map<string, string>();
  url = "";
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private stream: AbortController | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private refs = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private windows: Promise<Map<string, number>> | null = null;

  // Context window by "provider/model", from the configured providers.
  async contextWindows(): Promise<Map<string, number>> {
    const p = (this.windows ??= this.request<OcProviders>("GET", "/config/providers", homedir()).then((r) => {
      const m = new Map<string, number>();
      for (const prov of r.providers)
        for (const [key, model] of Object.entries(prov.models)) if (model.limit?.context) m.set(`${prov.id}/${key}`, model.limit.context);
      return m;
    }));
    return p.catch(() => {
      if (this.windows === p) this.windows = null;
      return new Map();
    });
  }

  async acquire(): Promise<() => void> {
    this.refs++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      await (this.ready ??= this.start());
    } catch (e) {
      this.release();
      throw e;
    }
    let released = false;
    return () => {
      if (!released) (released = true), this.release();
    };
  }

  private release() {
    if (--this.refs > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private async start() {
    const port = await freePort();
    const bin = process.env.CASM_OPENCODE_PATH ?? "opencode";
    const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    this.url = `http://127.0.0.1:${port}`;
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const listening = new Promise<void>((resolve, reject) => {
      proc.stdout!.on("data", (d) => String(d).includes("listening on") && resolve());
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`opencode serve exited (${code}): ${stderr.trim()}`)));
    });
    proc.once("exit", (code, signal) => this.died(`opencode serve exited (${signal ?? code})`));
    process.once("exit", () => proc.kill());
    await listening;
    await this.subscribe();
  }

  private async subscribe() {
    const ctrl = new AbortController();
    this.stream = ctrl;
    const res = await fetch(`${this.url}/global/event`, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`opencode event stream: HTTP ${res.status}`);
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body!) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) this.dispatch(data);
          }
        }
        if (this.stream === ctrl) this.died("opencode event stream ended");
      } catch (e) {
        if (this.stream === ctrl) this.died(`opencode event stream failed: ${e instanceof Error ? e.message : e}`);
      }
    })();
  }

  dispatch(data: string) {
    let payload: OcEvent | undefined;
    try {
      payload = (JSON.parse(data) as { payload?: OcEvent }).payload;
    } catch {
      return;
    }
    if (!payload?.properties) return;
    const p = payload.properties;
    const info = p.info as { id?: string; sessionID?: string; parentID?: string } | undefined;
    const part = p.part as OcPart | undefined;
    if (payload.type.startsWith("session.") && info?.id && info.parentID) this.parents.set(info.id, info.parentID);
    const sid = p.sessionID ?? part?.sessionID ?? info?.sessionID ?? info?.id;
    if (typeof sid !== "string") return;
    if (part?.tool === "task" && part.state?.metadata?.sessionId) this.parents.set(part.state.metadata.sessionId, sid);
    for (const l of this.listeners.get(sid) ?? []) l.onEvent(payload);
    const parent = this.parents.get(sid);
    if (parent) for (const l of this.listeners.get(parent) ?? []) l.onEvent(payload);
    if (payload.type === "session.deleted") this.parents.delete(sid);
  }

  private died(error: string) {
    if (!this.proc) return;
    this.proc = null;
    this.ready = null;
    this.windows = null;
    this.stream?.abort();
    this.stream = null;
    const all = [...this.listeners.values()].flatMap((s) => [...s]);
    this.listeners.clear();
    this.parents.clear();
    for (const l of all) l.onClosed(error);
  }

  stop() {
    const p = this.proc;
    this.died("opencode serve stopped");
    p?.kill();
  }

  linkChild(child: string, parent: string) {
    this.parents.set(child, parent);
  }

  listen(sessionId: string, l: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(l);
    return () => set.delete(l);
  }

  async request<T>(method: string, path: string, directory: string, body?: unknown): Promise<T> {
    const url = `${this.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

// --- session

function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const i = model?.indexOf("/") ?? -1;
  return model && i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : undefined;
}

class OpencodeSession implements ProviderSession {
  private opts: OpenOptions;
  private server: OpencodeServer;
  private sessionId: Promise<string>;
  private release: (() => void) | null = null;
  private unlisten: (() => void) | null = null;
  private closed = false;
  private busy = false;
  private interrupted = false;
  private error: string | undefined;
  private turnAbort = new AbortController();
  // Roles by message id, part types by part id, last emitted tool status by part id.
  private roles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  private toolStatus = new Map<string, string>();
  // Output streamed so far by running tool parts.
  private toolOutput = new Map<string, string>();
  // The current turn's user message (plans and retry notices are keyed by it).
  private userMessage: string | undefined;
  private errored = new Set<string>();
  // Assistant message infos with tokens, for usage totals (seeded from history on resume).
  private usageInfos = new Map<string, OcMessageInfo>();
  // Bumped when a turn ends, so a late HTTP failure of a finished turn is ignored.
  private turnSeq = 0;
  private sawBusy = false;
  // The running turn is a user shell command (its tool part is the command).
  private shellTurn = false;
  private nativeId: string | undefined;
  private tasks = new Map<string, Extract<Item, { kind: "subagent" }>>();
  private childTasks = new Map<string, string>();
  private activity = new Map<string, string>();

  constructor(opts: OpenOptions, server: OpencodeServer) {
    this.opts = opts;
    this.server = server;
    this.sessionId = this.init();
    this.sessionId.catch((e) => this.finish(e instanceof Error ? e.message : String(e)));
  }

  private async init(): Promise<string> {
    this.release = await this.server.acquire();
    if (this.closed) {
      this.release();
      throw new Error("closed");
    }
    // Warm the context window lookup so usage events aren't delayed.
    void this.server.contextWindows();
    const id =
      this.opts.resumeId ?? (await this.server.request<{ id: string }>("POST", "/session", this.opts.cwd, {})).id;
    this.nativeId = id;
    this.unlisten = this.server.listen(id, { onEvent: (e) => this.handle(e), onClosed: (err) => this.finish(err) });
    this.opts.emit({ type: "sessionId", id });
    if (this.opts.resumeId) {
      try {
        const messages = await this.server.request<OcMessage[]>("GET", `/session/${id}/message`, this.opts.cwd);
        for (const m of messages) for (const p of m.parts) this.task(p, false);
        for (const m of messages) if (m.info.role === "assistant" && m.info.tokens && !this.usageInfos.has(m.info.id)) this.usageInfos.set(m.info.id, m.info);
      } catch {
        // Totals then count from this process on.
      }
    }
    return id;
  }

  private async emitUsage() {
    const windows = await this.server.contextWindows();
    const usage = sessionUsage([...this.usageInfos.values()], (m) => windows.get(m));
    if (usage) this.emit({ type: "usage", usage });
  }

  private emit(e: ProviderEvent) {
    if (!this.closed) this.opts.emit(e);
  }

  private task(part: OcPart, emit = true): boolean {
    const item = normalizePart(part);
    if (item?.kind !== "subagent") return false;
    const child = part.state?.metadata?.sessionId;
    if (child) {
      this.childTasks.set(child, item.id);
      this.server.linkChild(child, part.sessionID);
    }
    const activity = child ? this.activity.get(child) : undefined;
    const updated = { ...item, ...(activity ? { activity } : {}) };
    this.tasks.set(item.id, updated);
    if (emit) this.emit({ type: "item", item: updated });
    return true;
  }

  private handle(e: OcEvent) {
    const p = e.properties;
    const part = p.part as OcPart | undefined;
    const sid = p.sessionID ?? part?.sessionID ?? (p.info as OcMessageInfo | undefined)?.sessionID;
    if (sid && sid !== this.nativeId) {
      // Child text, reasoning, usage and status never enter the parent transcript.
      if (e.type === "message.part.updated" && part?.type === "tool") {
        const activity = part.tool ?? "tool";
        this.activity.set(String(sid), activity);
        const id = this.childTasks.get(String(sid));
        const task = id ? this.tasks.get(id) : undefined;
        if (task?.status === "running") {
          const updated = { ...task, activity };
          this.tasks.set(task.id, updated);
          this.emit({ type: "item", item: updated });
        }
      } else if (e.type === "permission.asked") void this.permission(p as unknown as OcPermission);
      else if (e.type === "question.asked") void this.question(p as unknown as OcQuestion);
      return;
    }
    switch (e.type) {
      case "message.updated": {
        const info = p.info as OcMessageInfo;
        this.roles.set(info.id, info.role);
        if (info.role === "user") this.userMessage = info.id;
        if (info.error && info.error.name !== "MessageAbortedError") {
          this.error = errorText(info.error);
          if (!this.errored.has(info.id)) this.errored.add(info.id), this.emit({ type: "item", item: errorItem(info.id, info.error) });
        }
        // Tokens are filled in when a step finishes.
        if (info.role === "assistant" && info.tokens && promptTokens(info.tokens) > 0) {
          const prev = this.usageInfos.get(info.id)?.tokens;
          if (JSON.stringify(prev) !== JSON.stringify(info.tokens) || this.usageInfos.get(info.id)?.cost !== info.cost) {
            this.usageInfos.set(info.id, info);
            void this.emitUsage();
          }
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part as OcPart;
        this.partTypes.set(part.id, part.type);
        if (part.type === "compaction") {
          this.emit({ type: "item", item: normalizePart(part)! });
          return;
        }
        if (this.roles.get(part.messageID) !== "assistant") return;
        if (this.task(part)) return;
        // The todo list arrives as todo.updated.
        if (part.type === "tool" && part.tool === "todowrite") return;
        let item = normalizePart(part, this.userMessage);
        if (!item) return;
        if (item.kind === "tool" && this.shellTurn) item = shellTool(item);
        if (item.kind === "tool") {
          if (part.state?.status === "pending") return;
          if (this.toolStatus.get(item.id) !== item.status) {
            this.toolStatus.set(item.id, item.status);
            this.emit({ type: "item", item });
          }
          // Running updates repeat with the output so far.
          const out = part.state?.metadata?.output;
          if (item.status === "running" && typeof out === "string") {
            const delta = outputDelta(this.toolOutput.get(item.id) ?? "", out);
            this.toolOutput.set(item.id, out);
            if (delta) this.emit({ type: "toolOutput", itemId: item.id, text: delta });
          } else if (item.status !== "running") this.toolOutput.delete(item.id);
          return;
        }
        if (item.kind !== "notice" && !part.time?.end) return;
        this.emit({ type: "item", item });
        return;
      }
      case "todo.updated": {
        const todos = p.todos as OcTodo[];
        this.emit({ type: "item", item: { kind: "plan", id: planId(this.userMessage ?? String(p.sessionID)), entries: planEntries(todos) } });
        return;
      }
      case "message.part.delta": {
        if (p.field !== "text" || this.roles.get(String(p.messageID)) !== "assistant") return;
        const kind = this.partTypes.get(String(p.partID));
        if (kind === "text") this.emit({ type: "delta", kind: "assistant", text: String(p.delta) });
        else if (kind === "reasoning") this.emit({ type: "delta", kind: "reasoning", text: String(p.delta) });
        return;
      }
      case "session.error": {
        const err = p.error as OcError | undefined;
        if (err && err.name !== "MessageAbortedError") this.error = errorText(err);
        return;
      }
      case "session.status": {
        const status = p.status as { type: string; attempt?: number; message?: string; next?: number };
        if (status.type === "busy") (this.busy = true), (this.sawBusy = true);
        else if (status.type === "idle" && this.busy) this.endTurn();
        else if (status.type === "retry") {
          this.sawBusy = true;
          const wait = status.next ? Math.max(0, Math.round((status.next - Date.now()) / 1000)) : 0;
          const text = `Retry attempt ${status.attempt ?? "?"}: ${status.message ?? "request failed"}${wait ? ` (retrying in ${wait}s)` : ""}`;
          this.emit({ type: "item", item: { kind: "notice", id: retryId(this.userMessage ?? String(p.sessionID)), text, level: "warning" } });
        }
        return;
      }
      case "permission.asked":
        void this.permission(p as unknown as OcPermission);
        return;
      case "question.asked":
        void this.question(p as unknown as OcQuestion);
        return;
    }
  }

  private async question(q: OcQuestion) {
    const signal = this.turnAbort.signal;
    let answers: Answers | null = null;
    try {
      answers = await this.opts.askQuestion(questionRequest(q), signal);
    } catch {
      // Aborted: reject so the tool call ends like a dismissal.
    }
    const path = answers ? `/question/${q.id}/reply` : `/question/${q.id}/reject`;
    const body = answers ? { answers: questionReply(q, answers) } : undefined;
    await this.server.request("POST", path, this.opts.cwd, body).catch(() => {
      // The server already dropped it (turn aborted or answered elsewhere).
    });
  }

  private async permission(req: OcPermission) {
    const signal = this.turnAbort.signal;
    try {
      const answer = await this.opts.askPermission(
        {
          id: req.id,
          toolName: req.permission,
          input: req.metadata,
          title: `${req.permission} ${req.patterns.join(", ")}`.trim(),
          canAlwaysAllow: req.always.length > 0,
        },
        signal,
      );
      const reply = answer.decision === "allow" ? "once" : answer.decision === "allowAlways" ? "always" : "reject";
      await this.server.request("POST", `/permission/${req.id}/reply`, this.opts.cwd, {
        reply,
        message: reply === "reject" ? answer.message : undefined,
      });
    } catch {
      // Aborted turn or a stale request; the server cleans up on abort.
    }
  }

  private endTurn() {
    const interrupted = this.interrupted;
    const error = this.error;
    this.busy = false;
    this.sawBusy = false;
    this.shellTurn = false;
    this.turnSeq++;
    this.interrupted = false;
    this.error = undefined;
    this.turnAbort.abort();
    this.turnAbort = new AbortController();
    if (interrupted) this.emit({ type: "turnEnded", outcome: "interrupted" });
    else this.emit({ type: "turnEnded", outcome: error ? "failed" : "completed", error });
  }

  private finish(error: string) {
    if (this.closed) return;
    this.emit({ type: "closed", error });
    void this.close();
  }

  send(text: string, itemId: string, images?: ImageData[]) {
    const { config, cwd } = this.opts;
    const seq = this.turnSeq;
    const files = imageParts(images);
    void this.sessionId
      .then(async (id) => {
        this.busy = true;
        const messageID = `msg_${itemId.replaceAll("-", "")}`;
        this.emit({ type: "userMessageId", itemId, nativeId: messageID });
        const slash = parseSlash(text);
        if (slash) {
          const commands = await this.server.request<OcCommand[]>("GET", "/command", cwd).catch(() => []);
          if (commands.some((c) => c.name === slash.name)) {
            // Blocks until the command's turn is done; the event stream drives the turn.
            return this.server.request("POST", `/session/${id}/command`, cwd, {
              messageID,
              command: slash.name,
              arguments: slash.args,
              model: config.model,
              agent: config.mode,
              variant: config.effort,
              ...(files.length ? { parts: files } : {}),
            });
          }
        }
        return this.server.request("POST", `/session/${id}/prompt_async`, cwd, {
          messageID,
          parts: [...(text.trim() ? [{ type: "text", text }] : []), ...files],
          model: modelRef(config.model),
          agent: config.mode,
          variant: config.effort,
          system: config.systemPrompt,
        });
      })
      .catch((e) => this.sendFailed(seq, e));
  }

  // A failure after the turn got going is reported by the event stream.
  private sendFailed(seq: number, e: unknown) {
    if (this.closed || seq !== this.turnSeq || this.sawBusy) return;
    this.busy = false;
    this.shellTurn = false;
    this.emit({ type: "turnEnded", outcome: "failed", error: e instanceof Error ? e.message : String(e) });
  }

  // POST /session/:id/shell runs the command in the session's directory and
  // stores it as a tool call the model sees on the next prompt. It blocks until
  // the command is done; the event stream drives the turn like a prompt's. The
  // item id is the tool part's.
  shell(command: string, _itemId: string) {
    const { config, cwd } = this.opts;
    const seq = this.turnSeq;
    this.shellTurn = true;
    void this.sessionId
      .then(async (id) => {
        this.busy = true;
        const agent = config.mode ?? (await this.server.request<{ default_agent?: string }>("GET", "/config", cwd).catch(() => null))?.default_agent ?? "build";
        return this.server.request("POST", `/session/${id}/shell`, cwd, { agent, command, model: modelRef(config.model) });
      })
      .catch((e) => this.sendFailed(seq, e));
  }

  async interrupt() {
    this.interrupted = true;
    this.turnAbort.abort();
    const id = await this.sessionId;
    await this.server.request("POST", `/session/${id}/abort`, this.opts.cwd);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort.abort();
    if (this.busy) {
      const id = await this.sessionId.catch(() => null);
      if (id) await this.server.request("POST", `/session/${id}/abort`, this.opts.cwd).catch(() => {});
    }
    this.unlisten?.();
    this.release?.();
  }
}

export function opencodeProvider(server = new OpencodeServer()): Provider {
  return {
    id: "opencode",
    open: (opts) => new OpencodeSession(opts, server),
    async history(sessionId, cwd) {
      const release = await server.acquire();
      try {
        return normalizeMessages(await server.request<OcMessage[]>("GET", `/session/${sessionId}/message`, cwd));
      } finally {
        release();
      }
    },
    async subagentHistory(sessionId, cwd, subagentId) {
      const release = await server.acquire();
      try {
        const messages = await server.request<OcMessage[]>("GET", `/session/${sessionId}/message`, cwd);
        const task = messages.flatMap((m) => m.parts).find((p) => p.id === subagentId && p.type === "tool" && p.tool === "task");
        const child = task?.state?.metadata?.sessionId;
        if (!child) return [];
        const info = await server.request<{ parentID?: string }>("GET", `/session/${child}`, cwd);
        if (info.parentID !== sessionId) return [];
        return normalizeMessages(await server.request<OcMessage[]>("GET", `/session/${child}/message`, cwd));
      } finally {
        release();
      }
    },
    async usage(sessionId, cwd) {
      const release = await server.acquire();
      try {
        const [messages, windows] = await Promise.all([
          server.request<OcMessage[]>("GET", `/session/${sessionId}/message`, cwd),
          server.contextWindows(),
        ]);
        return sessionUsage(
          messages.map((m) => m.info),
          (m) => windows.get(m),
        );
      } finally {
        release();
      }
    },
    async commands(cwd) {
      const release = await server.acquire();
      try {
        return parseCommands(await server.request<OcCommand[]>("GET", "/command", cwd));
      } finally {
        release();
      }
    },
    async catalog() {
      const release = await server.acquire();
      try {
        const dir = homedir();
        const [providers, agents, config] = await Promise.all([
          server.request<OcProviders>("GET", "/config/providers", dir),
          server.request<OcAgent[]>("GET", "/agent", dir),
          server.request<{ model?: string }>("GET", "/config", dir),
        ]);
        return parseCatalog(providers, agents, config.model);
      } finally {
        release();
      }
    },
  };
}

import { providerEnv } from "./env.ts";
import { toolImages } from "./tool-images.ts";
// pi via `pi --mode rpc`: one process per open session, JSONL commands on
// stdin, responses and session events on stdout. The native session id is the
// session file path (what `--session` resumes); history reads that file.
//
// pi has no permission system of its own. Extensions can ask through dialogs
// (extension_ui_request): `confirm` goes through askPermission; `select`,
// `input` and `editor` become questions.
//
// MCP: casm passes the agent's config.mcpServers through pi-extension.ts,
// which registers them for the session only. pi's RPC protocol has no MCP
// commands, so status and reconnect run its built-in /mcp command and read what
// it reports through notify, and /casm-mcp enables or disables the servers casm
// added.
//
// pi has no built-in todo tool. Todo lists written by extensions are mapped to
// Item.plan when they use the shape of pi's example extensions: a tool result
// with `details.todos` (examples/extensions/todo.ts) or a custom entry with
// `data.todos` (examples/extensions/plan-mode).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Answers, Catalog, Command, ImageData, Item, McpServer, ModelInfo, PlanEntry, QuestionRequest, Usage } from "@casm/protocol";
import { COMMAND as CASM_MCP_COMMAND, ENV as CASM_MCP_ENV } from "./pi-extension.ts";
import type { CostEntry, OpenOptions, Provider, ProviderSession } from "./types.ts";
import { isoTime, TimedItems } from "../item-times.ts";

const MAX_TOOL_OUTPUT = 8000;
// History drops image data above this many base64 characters (~1 MB decoded).
const MAX_HISTORY_IMAGE = 1_400_000;

// --- normalization (shared by history and live events)

type Block = { type: string; [k: string]: unknown };
type Tool = Extract<Item, { kind: "tool" }>;
type Notice = Extract<Item, { kind: "notice" }>;
type Plan = Extract<Item, { kind: "plan" }>;

export type PiUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
};

// A user shell command (`!cmd`, the RPC `bash` command) as a tool item. A
// cancelled command has no exit code.
export function shellItem(id: string, command: string, output: string | undefined, exitCode: number | undefined, cancelled?: boolean): Tool {
  return { kind: "tool", id, name: "shell", origin: "user", input: { command }, status: exitCode === 0 && !cancelled ? "done" : "error", output: truncate(output ?? "") };
}

export type PiMessage = {
  role: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  display?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  summary?: string;
  details?: unknown;
  model?: string;
  provider?: string;
  usage?: PiUsage;
};

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : text;
}

function text(content: unknown): string {
  return blocks(content)
    .map((b) => (b.type === "text" ? String(b.text) : `[${b.type}]`))
    .join("\n");
}

// User content: text blocks joined, image blocks as ImageData.
function userContent(content: unknown): { text: string; images?: ImageData[] } {
  const parts: string[] = [];
  const images: ImageData[] = [];
  for (const b of blocks(content)) {
    if (b.type === "text") parts.push(String(b.text));
    else if (b.type === "image") {
      const data = typeof b.data === "string" ? b.data : undefined;
      images.push({ mediaType: String(b.mimeType ?? "image/png"), ...(data && data.length <= MAX_HISTORY_IMAGE ? { data } : {}) });
    }
  }
  return { text: parts.join("\n").trim(), ...(images.length ? { images } : {}) };
}

// A todo list in one of the shapes pi extensions use: {text|content|title,
// status?, done?|completed?}. Null when `todos` isn't such a list.
export function planEntries(todos: unknown): PlanEntry[] | null {
  if (!Array.isArray(todos)) return null;
  const out: PlanEntry[] = [];
  for (const t of todos as Record<string, unknown>[]) {
    if (!t || typeof t !== "object") return null;
    const label = str(t.text) ?? str(t.content) ?? str(t.title);
    if (!label) return null;
    const s = String(t.status ?? "").replace("-", "_");
    const status: PlanEntry["status"] =
      s === "pending" || s === "in_progress" || s === "completed"
        ? s
        : t.done === true || t.completed === true || s === "done"
          ? "completed"
          : "pending";
    out.push({ text: label, status });
  }
  return out;
}

const todosOf = (v: unknown) => (v && typeof v === "object" ? (v as { todos?: unknown }).todos : undefined);

// A custom entry (appendEntry) that carries a todo list, as a plan.
export function customPlan(entry: { customType?: string; data?: unknown }): Plan | null {
  const entries = planEntries(todosOf(entry.data));
  return entries ? { kind: "plan", id: `plan:${entry.customType ?? "custom"}`, entries } : null;
}

// Tokens in the model context after this response (pi's calculateContextTokens).
export function contextTokens(u: PiUsage | undefined): number {
  if (!u) return 0;
  return u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

// Usage carried by one assistant message; null for aborted/failed/empty ones.
export function messageUsage(m: PiMessage): Usage | null {
  if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") return null;
  const ctx = contextTokens(m.usage);
  if (!ctx) return null;
  return { ...(m.model ? { model: m.model } : {}), contextTokens: ctx };
}

// Turns one pi message into items. Assistant blocks are keyed by the message
// timestamp, which is the same live and on disk. `tools` carries tool calls so
// a later toolResult can complete them; completed tools are returned again so
// callers can upsert. `fallbackId` names messages without a timestamp.
export function normalize(msg: PiMessage, tools: Map<string, Tool>, fallbackId = ""): Item[] {
  const key = msg.timestamp !== undefined ? String(msg.timestamp) : fallbackId;
  const out: Item[] = [];
  switch (msg.role) {
    case "user": {
      const u = userContent(msg.content);
      if (u.text || u.images) out.push({ kind: "user", id: fallbackId || key, ...u });
      break;
    }
    case "assistant":
      blocks(msg.content).forEach((b, i) => {
        const id = `${key}:${i}`;
        if (b.type === "text" && String(b.text).trim()) out.push({ kind: "assistant", id, text: String(b.text) });
        else if (b.type === "thinking" && String(b.thinking ?? "").trim())
          out.push({ kind: "reasoning", id, text: String(b.thinking) });
        else if (b.type === "toolCall") {
          // An aborted or failed message never runs its tool calls.
          const dead = msg.stopReason === "aborted" || msg.stopReason === "error";
          const item: Tool = { kind: "tool", id: String(b.id), name: String(b.name), input: b.arguments, status: dead ? "error" : "running" };
          tools.set(item.id, item);
          out.push(item);
        }
      });
      if (msg.stopReason === "error" && msg.errorMessage)
        out.push({ kind: "notice", id: `${key}:error`, text: msg.errorMessage, level: "error" });
      else if (msg.stopReason === "length")
        out.push({ kind: "notice", id: `${key}:length`, text: "The response hit the output token limit and was cut off.", level: "warning" });
      break;
    case "toolResult": {
      const id = String(msg.toolCallId);
      const prev = tools.get(id);
      const done: Tool = {
        kind: "tool",
        id,
        name: prev?.name ?? msg.toolName ?? "tool",
        input: prev?.input,
        status: msg.isError ? "error" : "done",
        output: truncate(text(msg.content)),
        ...toolImages(msg.content),
      };
      tools.set(id, done);
      out.push(done);
      const entries = planEntries(todosOf(msg.details));
      if (entries) out.push({ kind: "plan", id: `plan:${done.name}`, entries });
      break;
    }
    case "bashExecution":
      out.push(shellItem(key, String(msg.command ?? ""), msg.output, msg.exitCode, msg.cancelled));
      break;
    case "custom":
      if (msg.display) {
        const t = text(msg.content).trim();
        if (t) out.push({ kind: "notice", id: key, text: t, level: "info" });
      }
      break;
  }
  return out;
}

type Entry = {
  type: string;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  message?: PiMessage;
  summary?: string;
  customType?: string;
  data?: unknown;
  content?: unknown;
  display?: boolean;
  usage?: PiUsage;
};

function entriesOf(jsonl: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e.id) entries.push(e);
    } catch {}
  }
  return entries;
}

// The active branch: last entry back to the root.
function activePath(entries: Entry[]): Entry[] {
  const byId = new Map(entries.map((e) => [e.id!, e]));
  const path: Entry[] = [];
  for (let e = entries.at(-1); e; e = e.parentId ? byId.get(e.parentId) : undefined) path.unshift(e);
  return path;
}

// Normalizes a session file along the active branch.
export function parseSession(jsonl: string): Item[] {
  const tools = new Map<string, Tool>();
  const items = new TimedItems();
  // The entry being read: its timestamp dates the items it produces.
  let at: string | undefined;
  const put = (item: Item) => items.put(item, at);
  // A failed response directly followed by another one was retried by pi.
  let failed: Notice | null = null;
  for (const e of activePath(entriesOf(jsonl))) {
    at = isoTime(e.timestamp ?? e.message?.timestamp);
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (failed && m.role === "assistant") put({ ...failed, text: `Retried after: ${failed.text}`, level: "warning" });
      if (m.role !== "system") failed = null;
      // A tool result replaces its call in place.
      for (const item of normalize(m, tools, e.id)) {
        put(item);
        if (item.kind === "notice" && item.level === "error" && m.role === "assistant") failed = item;
      }
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      const label = e.type === "compaction" ? "Context compacted" : "Branch summary";
      put({ kind: "notice", id: e.id!, text: `${label}: ${e.summary ?? ""}`.trim(), level: "info" });
    } else if (e.type === "custom_message" && e.display) {
      const t = text(e.content).trim();
      if (t) put({ kind: "notice", id: e.id!, text: t, level: "info" });
    } else if (e.type === "custom") {
      const plan = customPlan(e);
      if (plan) put(plan);
    }
  }
  return items.values();
}

// Last known usage from a session file: context of the latest valid assistant
// response on the active branch (unknown right after a compaction), and token
// and cost totals over every entry, as pi's get_session_stats counts them.
// `contextWindow` comes from the model list.
export function sessionUsage(jsonl: string, contextWindow?: (provider: string, model: string) => number | undefined): Usage | null {
  const entries = entriesOf(jsonl);
  let input = 0;
  let output = 0;
  let cost = 0;
  let any = false;
  const add = (u: PiUsage | undefined) => {
    if (!u) return;
    any = true;
    input += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    output += u.output ?? 0;
    cost += u.cost?.total ?? 0;
  };
  for (const e of entries) {
    if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") add(e.usage);
    else if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) add(e.message.usage);
  }
  let last: PiMessage | undefined;
  let ctx: number | undefined;
  for (const e of activePath(entries)) {
    if (e.type === "compaction") ctx = undefined;
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    last = e.message;
    const u = messageUsage(e.message);
    if (u) ctx = u.contextTokens;
  }
  if (!any && !last) return null;
  const window = last?.provider && last.model ? contextWindow?.(last.provider, last.model) : undefined;
  return {
    ...(last?.model ? { model: last.model } : {}),
    ...(ctx !== undefined ? { contextTokens: ctx } : {}),
    ...(window ? { contextWindow: window } : {}),
    inputTokens: input,
    outputTokens: output,
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
}

// The cost of every call a session file records (the entries sessionUsage
// totals), timed by the message or else the entry. Free and unpriced ones are left out.
export function sessionCosts(jsonl: string): CostEntry[] {
  const out: CostEntry[] = [];
  const add = (u: PiUsage | undefined, ...times: (string | number | undefined)[]) => {
    const cost = u?.cost?.total ?? 0;
    const at = times.map((t) => (t === undefined ? NaN : new Date(t).getTime())).find((t) => Number.isFinite(t));
    if (cost > 0 && at !== undefined) out.push({ at, costUsd: cost });
  };
  for (const e of entriesOf(jsonl)) {
    if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") add(e.usage, e.timestamp);
    else if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) add(e.message.usage, e.message.timestamp, e.timestamp);
  }
  return out;
}

// The part of a cumulative tool output snapshot not yet streamed. Snapshots
// keep the tail when output grows large, so after a cut the overlap is found
// by the previous tail.
export function outputDelta(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length);
  const tail = prev.slice(-Math.min(200, Math.ceil(prev.length / 2)));
  const at = tail ? next.lastIndexOf(tail) : -1;
  return at >= 0 ? next.slice(at + tail.length) : next;
}

// --- MCP

const EXTENSION = fileURLToPath(new URL("./pi-extension.ts", import.meta.url));
// pi's rule for MCP server names; anything else can't be one.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

// The plain-text status pi's /mcp prints outside its TUI: one
// `<name>: <state>[, N tools] (<exposure>)` line per server, an indented error
// below failed ones, then `config error:` and `overridden:` lines. Servers
// casm didn't add can't be toggled (pi saves that to its mcp.json files).
export function parseMcpStatus(text: string, toggleable: ReadonlySet<string>): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of text.split("\n")) {
    const last = servers.at(-1);
    if (/^\s/.test(line)) {
      if (last && line.trim()) last.error = [last.error, line.trim()].filter(Boolean).join("\n");
      continue;
    }
    const m = /^([A-Za-z0-9_-]+): ([^"].*?)(?: \([\w-]+\))?$/.exec(line);
    if (!m) continue;
    const [, name, state] = m;
    const tools = /^connected, (\d+) tools?$/.exec(state);
    const status: McpServer["status"] = state.startsWith("connected") ? "connected" : state === "disabled" ? "disabled"
      : state.startsWith("failed") ? "failed" : state.startsWith("needs sign-in") ? "needs-auth" : "pending";
    servers.push({
      name, status, tools: tools ? Number(tools[1]) : 0,
      ...(tools ? {} : { toolsKnown: false }),
      ...(state.startsWith("disconnected") ? { error: "disconnected; reconnects on its next call" } : {}),
      ...(toggleable.has(name) ? {} : { canToggle: false }),
    });
  }
  return servers;
}

// --- dialogs and catalog

type Rec = { type: string; id?: string; [k: string]: unknown };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// A select/input/editor extension_ui_request as a one-prompt question; null for
// other methods. The prompt id is the method.
export function dialogQuestion(r: Rec): QuestionRequest | null {
  const method = String(r.method);
  const text = [str(r.title), str(r.message)].filter(Boolean).join("\n\n") || method;
  const base = { id: method, text };
  switch (method) {
    case "select": {
      const options = Array.isArray(r.options) ? (r.options as unknown[]).map((o) => ({ label: String(o) })) : [];
      return { id: String(r.id), prompts: [{ ...base, kind: "select", options }] };
    }
    case "input":
      return { id: String(r.id), prompts: [{ ...base, kind: "text", placeholder: str(r.placeholder) }] };
    case "editor":
      return { id: String(r.id), prompts: [{ ...base, kind: "text", multiline: true, placeholder: str(r.prefill) }] };
  }
  return null;
}

// The extension_ui_response for a question's answers; null answers cancel.
export function dialogResponse(req: QuestionRequest, answers: Answers | null): Rec {
  const prompt = req.prompts[0];
  const v = answers?.[prompt.id];
  const value = Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;
  return value === undefined ? { type: "extension_ui_response", id: req.id, cancelled: true } : { type: "extension_ui_response", id: req.id, value };
}

type PiModel = {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// pi-ai getSupportedThinkingLevels: null in the map disables a level; xhigh and
// max must be mapped explicitly.
function thinkingLevels(m: PiModel): string[] {
  if (!m.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

// The model a session runs, as casm names it: config.model when that names it
// (bare or provider/id, as the catalog may), else the bare id.
export function modelName(model: { id: string; provider?: string }, configured?: string): string {
  return configured && (configured === model.id || configured === `${model.provider}/${model.id}`) ? configured : model.id;
}

// get_available_models plus the default model from get_state. Ids are bare
// unless several providers share one, then `provider/id` (both work for --model).
export function parseCatalog(models: PiModel[], current?: { id: string; provider: string }): Catalog {
  const count = new Map<string, number>();
  for (const m of models) count.set(m.id, (count.get(m.id) ?? 0) + 1);
  return {
    models: models.map((m): ModelInfo => {
      const shared = count.get(m.id)! > 1;
      return {
        id: shared ? `${m.provider}/${m.id}` : m.id,
        name: shared ? `${m.name ?? m.id} (${m.provider})` : (m.name ?? m.id),
        description: m.provider,
        isDefault: current?.id === m.id && current.provider === m.provider,
        efforts: thinkingLevels(m),
      };
    }),
    modes: [],
  };
}

type PiCommand = { name: string; description?: string; source?: string; sourceInfo?: { path?: string } };

// The `argument-hint` frontmatter of a prompt template (get_commands omits it).
export function argumentHint(markdown: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const m = fm && /^argument-hint:[ \t]*(.+)$/m.exec(fm[1]);
  return m ? m[1].trim().replace(/^(["'])(.*)\1$/, "$2") || undefined : undefined;
}

// get_commands: extension commands, prompt templates and skills (`skill:name`).
export function parseCommands(commands: PiCommand[], hints: Map<string, string> = new Map()): Command[] {
  return commands.map((c): Command => {
    const hint = hints.get(c.name);
    return {
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(hint ? { argumentHint: hint } : {}),
      kind: c.source === "skill" ? "skill" : "command",
    };
  });
}

// A short-lived `pi --mode rpc --no-session` (no session file, no inference)
// that answers `cmds` and exits. Resolves with the responses by command id.
function piQuery(cmds: Rec[], cwd?: string): Promise<Map<string, Rec>> {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "rpc", "--no-session"];
    if (process.env.CASM_PI_ARGS) args.push(...process.env.CASM_PI_ARGS.split(" ").filter(Boolean));
    const proc = spawn(process.env.CASM_PI_PATH ?? "pi", args, { cwd, env: providerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map<string, Rec>();
    let buf = "";
    let stderr = "";
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.stdin.end();
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      if (err) reject(err);
      else resolve(responses);
    };
    const timer = setTimeout(() => finish(new Error("pi query timed out")), 30_000);
    proc.on("error", (e) => finish(e));
    proc.on("exit", (code) => finish(new Error(`pi exited with code ${code}: ${stderr.trim()}`)));
    proc.stdin.on("error", () => {});
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-2000)));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const r = JSON.parse(line) as Rec;
          if (r.type === "response" && r.id && cmds.some((c) => c.id === r.id)) responses.set(r.id, r);
        } catch {}
        if (responses.size === cmds.length) return finish();
      }
    });
    for (const c of cmds) proc.stdin.write(JSON.stringify(c) + "\n");
  });
}

function ok(r: Rec | undefined, what: string): unknown {
  if (!r?.success) throw new Error(`pi ${what}: ${String(r?.error ?? "no response")}`);
  return r.data;
}

// Context windows by `provider/id`, filled by every model listing.
let windows: Map<string, number> | null = null;

function rememberModels(models: PiModel[]) {
  windows = new Map(models.filter((m) => m.contextWindow).map((m) => [`${m.provider}/${m.id}`, m.contextWindow!]));
}

async function fetchCatalog(): Promise<Catalog> {
  const r = await piQuery([
    { type: "get_state", id: "state" },
    { type: "get_available_models", id: "models" },
  ]);
  const { models } = ok(r.get("models"), "get_available_models") as { models: PiModel[] };
  rememberModels(models);
  const current = (r.get("state")?.data as { model?: { id: string; provider: string } } | undefined)?.model;
  return parseCatalog(models, current);
}

async function contextWindows(): Promise<Map<string, number>> {
  if (!windows) {
    const r = await piQuery([{ type: "get_available_models", id: "models" }]);
    rememberModels((ok(r.get("models"), "get_available_models") as { models: PiModel[] }).models);
  }
  return windows!;
}

async function fetchCommands(cwd: string): Promise<Command[]> {
  const r = await piQuery([{ type: "get_commands", id: "commands" }], cwd);
  const { commands } = ok(r.get("commands"), "get_commands") as { commands: PiCommand[] };
  const hints = new Map<string, string>();
  await Promise.all(
    commands
      .filter((c) => c.source === "prompt" && c.sourceInfo?.path)
      .map(async (c) => {
        const hint = argumentHint(await readFile(c.sourceInfo!.path!, "utf8").catch(() => ""));
        if (hint) hints.set(c.name, hint);
      }),
  );
  return parseCommands(commands, hints);
}

// --- RPC process

class PiSession implements ProviderSession {
  private proc: ChildProcessWithoutNullStreams;
  private opts: OpenOptions;
  private tools = new Map<string, Tool>();
  private pending = new Map<string, (r: Rec) => void>();
  private seq = 0;
  private buf = "";
  private stderr = "";
  private running = false;
  private casmTurnId?: string;
  private sentUserIds: string[] = [];
  private interrupted = false;
  private lastError: string | undefined;
  private turnAbort = new AbortController();
  private dead = false;
  // Streamed output already sent per running tool call.
  private toolOutput = new Map<string, string>();
  // Ids of the notices that later events update in place.
  private retryNotice: string | null = null;
  private failedNotice: string | null = null;
  private compactionNotice: string | null = null;
  private summaryRetryNotice: string | null = null;
  private noticeSeq = 0;
  private model: string | undefined;
  // The running user shell command: its RPC id and tool item.
  private shellRun: { id: string; item: Tool } | null = null;
  // MCP servers casm added to this session (pi-extension.ts).
  private casmServers: Set<string>;
  // Slash commands run for MCP controls, one at a time; while one runs, its
  // notifications are its output instead of transcript notices.
  private commandQueue: Promise<unknown> = Promise.resolve();
  private captured: { id: string; notes: { level: string; text: string }[] } | null = null;
  private builtinMcp: Promise<boolean> | null = null;
  readonly mcpReconnectScope = "server" as const;
  mcpToggle?: (server: string, enabled: boolean) => Promise<void>;

  constructor(opts: OpenOptions) {
    this.opts = opts;
    const { cwd, config, resumeId } = opts;
    const args = ["--mode", "rpc"];
    if (resumeId) args.push("--session", resumeId);
    if (config.model) args.push("--model", config.model);
    if (config.effort) args.push("--thinking", config.effort);
    if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);
    const mcpServers = config.mcpServers ?? {};
    this.casmServers = new Set(Object.keys(mcpServers));
    if (this.casmServers.size) {
      args.push("-e", EXTENSION);
      this.mcpToggle = (server, enabled) => this.toggleMcp(server, enabled);
    }
    if (process.env.CASM_PI_ARGS) args.push(...process.env.CASM_PI_ARGS.split(" ").filter(Boolean));
    const env = this.casmServers.size ? { ...config.env, [CASM_MCP_ENV]: JSON.stringify(mcpServers) } : config.env;
    this.proc = spawn(process.env.CASM_PI_PATH ?? "pi", args, { cwd, env: providerEnv(env) });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.read(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-2000)));
    this.proc.on("error", (e) => this.exited(e.message));
    this.proc.on("exit", (code, signal) => {
      const detail = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.exited(code ? `pi exited with code ${code}${detail}` : signal ? `pi killed by ${signal}` : undefined);
    });
    this.proc.stdin.on("error", () => {});

    void this.request({ type: "get_state" }).then((r) => {
      const data = r.data as { sessionFile?: string; model?: { id: string; provider: string } } | undefined;
      if (r.success && data?.sessionFile) opts.emit({ type: "sessionId", id: data.sessionFile });
      if (r.success && data?.model?.id) this.reportModel(data.model);
    });
  }

  // The session's model; an assistant message may show a switch (/model, an extension).
  private reportModel(model: { id: string; provider?: string }) {
    const name = modelName(model, this.opts.config.model);
    if (name !== this.model) (this.model = name), this.opts.emit({ type: "model", model: name });
  }

  private exited(error: string | undefined) {
    if (this.dead) return;
    this.dead = true;
    this.running = false;
    for (const resolve of this.pending.values()) resolve({ type: "response", success: false, error: "pi exited" });
    this.pending.clear();
    this.turnAbort.abort();
    this.opts.emit({ type: "closed", error });
  }

  // Splits on LF only: readline would also split on U+2028/U+2029 inside JSON strings.
  private read(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        this.handle(JSON.parse(line) as Rec);
      } catch {}
    }
  }

  private write(cmd: object) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private request(cmd: Rec, id = `casm-${++this.seq}`): Promise<Rec> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ ...cmd, id });
    });
  }

  private handle(r: Rec) {
    const { emit } = this.opts;
    switch (r.type) {
      case "response": {
        // A command's output ends with its response, not when the caller resumes.
        if (this.captured && r.id === this.captured.id) this.captured = null;
        const resolve = r.id ? this.pending.get(r.id) : undefined;
        if (resolve) {
          this.pending.delete(r.id!);
          resolve(r);
        }
        return;
      }
      case "message_end": {
        const m = r.message as PiMessage;
        // Our own prompts (and steers) are emitted by the manager when sent.
        if (m.role === "user") {
          const itemId = this.sentUserIds.shift();
          if (itemId && m.timestamp !== undefined) emit({ type: "userMessageId", itemId, nativeId: `pi:${m.timestamp}` });
          // An extension's sendUserMessage: nobody else shows it.
          if (!itemId && this.running && !this.casmTurnId) for (const item of normalize(m, this.tools)) emit({ type: "item", item });
          return;
        }
        if (m.role === "assistant") {
          if (m.model) this.reportModel({ id: m.model, provider: m.provider });
          this.lastError = m.stopReason === "error" ? m.errorMessage || "pi reported an error" : undefined;
          this.failedNotice = m.stopReason === "error" && m.errorMessage ? `${m.timestamp}:error` : null;
        }
        if (m.role === "toolResult") this.toolOutput.delete(String(m.toolCallId));
        for (const item of normalize(m, this.tools)) emit({ type: "item", item });
        const usage = messageUsage(m);
        if (usage) {
          emit({ type: "usage", usage });
          void this.stats();
        }
        return;
      }
      case "bash_execution_update":
        if (this.shellRun && r.id === this.shellRun.id && str(r.delta)) emit({ type: "toolOutput", itemId: this.shellRun.item.id, text: String(r.delta) });
        return;
      case "tool_execution_update": {
        const id = String(r.toolCallId);
        const next = text((r.partialResult as { content?: unknown } | undefined)?.content);
        const prev = this.toolOutput.get(id) ?? "";
        const delta = outputDelta(prev, next);
        this.toolOutput.set(id, next);
        if (delta) emit({ type: "toolOutput", itemId: id, text: delta });
        return;
      }
      case "auto_retry_start": {
        // The failed response's error notice turns into the retry notice.
        this.retryNotice ??= this.failedNotice ?? this.noticeId("retry");
        const secs = Math.round(Number(r.delayMs ?? 0) / 1000);
        const why = str(r.errorMessage) ? `: ${r.errorMessage}` : "";
        this.notice(this.retryNotice, "warning", `Retrying (attempt ${r.attempt}/${r.maxAttempts}) in ${secs}s${why}`);
        return;
      }
      case "auto_retry_end": {
        const id = this.retryNotice ?? this.noticeId("retry");
        this.retryNotice = null;
        if (r.success) this.notice(id, "info", `Retry succeeded (attempt ${r.attempt})`);
        else this.notice(id, "error", `Retry failed after ${r.attempt} attempts${str(r.finalError) ? `: ${r.finalError}` : ""}`);
        return;
      }
      case "compaction_start":
        this.compactionNotice = this.noticeId("compaction");
        this.notice(this.compactionNotice, "info", `Compacting context (${String(r.reason ?? "manual")})…`);
        return;
      case "compaction_end": {
        const id = this.compactionNotice ?? this.noticeId("compaction");
        this.compactionNotice = null;
        const result = r.result as { summary?: string } | undefined;
        if (result) this.notice(id, "info", `Context compacted: ${result.summary ?? ""}`.trim());
        else if (r.aborted) this.notice(id, "warning", "Compaction aborted");
        else this.notice(id, "error", `Compaction failed${str(r.errorMessage) ? `: ${r.errorMessage}` : ""}`);
        void this.stats();
        return;
      }
      case "summarization_retry_scheduled": {
        this.summaryRetryNotice ??= this.noticeId("summary-retry");
        const secs = Math.round(Number(r.delayMs ?? 0) / 1000);
        const why = str(r.errorMessage) ? `: ${r.errorMessage}` : "";
        this.notice(this.summaryRetryNotice, "warning", `Retrying summarization (attempt ${r.attempt}/${r.maxAttempts}) in ${secs}s${why}`);
        return;
      }
      case "summarization_retry_finished":
        if (this.summaryRetryNotice) this.notice(this.summaryRetryNotice, "info", "Summarization retry finished");
        this.summaryRetryNotice = null;
        return;
      case "extension_error": {
        const where = [str(r.extensionPath) && basename(String(r.extensionPath)), str(r.event)].filter(Boolean).join(", ");
        this.notice(this.noticeId("extension-error"), "error", `Extension error${where ? ` (${where})` : ""}: ${String(r.error ?? "unknown")}`);
        return;
      }
      case "entry_appended": {
        const plan = customPlan((r.entry ?? {}) as { customType?: string; data?: unknown });
        if (plan) emit({ type: "item", item: plan });
        return;
      }
      case "message_update": {
        const ev = r.assistantMessageEvent as { type: string; delta?: string };
        if (ev.type === "text_delta") emit({ type: "delta", kind: "assistant", text: ev.delta ?? "" });
        else if (ev.type === "thinking_delta") emit({ type: "delta", kind: "reasoning", text: ev.delta ?? "" });
        return;
      }
      case "agent_start":
        // A run nobody sent: an extension started it (sendMessage with
        // triggerTurn, sendUserMessage) while idle. Adopt it.
        if (!this.running) {
          this.running = true;
          this.casmTurnId = undefined;
          this.turnAbort = new AbortController();
          emit({ type: "turnStarted", notice: "A pi extension started a turn" });
        }
        return;
      case "agent_settled":
        this.endTurn(r.aborted === true || this.interrupted ? "interrupted" : this.lastError ? "failed" : "completed", this.lastError);
        return;
      case "extension_ui_request":
        if (r.method === "notify" && this.captured) {
          this.captured.notes.push({ level: String(r.notifyType ?? "info"), text: String(r.message ?? "") });
          return;
        }
        if (r.method === "notify") {
          const level = r.notifyType === "warning" || r.notifyType === "error" ? r.notifyType : "info";
          if (str(r.message)) this.notice(`notify:${r.id}`, level, String(r.message));
          return;
        }
        void this.dialog(r);
        return;
    }
  }

  private noticeId(kind: string): string {
    return `${kind}:${Date.now()}:${++this.noticeSeq}`;
  }

  private notice(id: string, level: Notice["level"], text: string) {
    this.opts.emit({ type: "item", item: { kind: "notice", id, text, level } });
  }

  // Session totals and the context window, as pi reports them.
  private async stats() {
    const r = await this.request({ type: "get_session_stats" });
    if (!r.success) return;
    const d = r.data as {
      tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      cost?: number;
      contextUsage?: { tokens?: number | null; contextWindow?: number };
    };
    const t = d.tokens ?? {};
    const usage: Usage = {
      inputTokens: (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0),
      outputTokens: t.output ?? 0,
    };
    if (typeof d.contextUsage?.tokens === "number") usage.contextTokens = d.contextUsage.tokens;
    if (d.contextUsage?.contextWindow) usage.contextWindow = d.contextUsage.contextWindow;
    if (d.cost) usage.costUsd = d.cost;
    this.opts.emit({ type: "usage", usage });
  }

  private endTurn(outcome: "completed" | "interrupted" | "failed", error?: string, turnId = this.casmTurnId) {
    if (!this.running || turnId !== this.casmTurnId) return;
    this.running = false;
    this.sentUserIds = [];
    this.interrupted = false;
    this.lastError = undefined;
    this.turnAbort.abort();
    this.opts.emit({ type: "turnEnded", outcome, error: outcome === "failed" ? error : undefined, ...(turnId ? { turnId } : {}) });
  }

  private async dialog(r: Rec) {
    const id = String(r.id);
    // pi resolves a timed-out dialog itself; drop ours with it.
    const signals = [this.turnAbort.signal];
    if (typeof r.timeout === "number") signals.push(AbortSignal.timeout(r.timeout));
    const signal = AbortSignal.any(signals);
    if (r.method === "confirm") {
      const title = [r.title, r.message].filter((s) => typeof s === "string" && s).join("\n\n");
      try {
        if (signal.aborted) throw new Error("aborted");
        const answer = await this.opts.askPermission(
          { id, toolName: "pi confirm", input: { title: r.title, message: r.message }, title, canAlwaysAllow: false },
          signal,
        );
        this.write({ type: "extension_ui_response", id, confirmed: answer.decision !== "deny" });
      } catch {
        this.write({ type: "extension_ui_response", id, cancelled: true });
      }
      return;
    }
    const req = dialogQuestion(r);
    if (!req) return;
    try {
      if (signal.aborted) throw new Error("aborted");
      this.write(dialogResponse(req, await this.opts.askQuestion(req, signal)));
    } catch {
      this.write(dialogResponse(req, null));
    }
  }

  send(text: string, itemId: string, images?: ImageData[], turnId?: string) {
    this.sentUserIds.push(itemId);
    const native = images?.filter((i) => i.data).map((i) => ({ type: "image", data: i.data, mimeType: i.mediaType }));
    const extra = native?.length ? { images: native } : {};
    const forget = () => { this.sentUserIds = this.sentUserIds.filter((id) => id !== itemId); };
    const steered = (response: Rec) => {
      const disposition = (response.data as { disposition?: string } | undefined)?.disposition;
      if (!response.success || disposition === "handled") forget();
    };
    if (this.running) {
      // `steer` refuses extension commands; `prompt` with streamingBehavior runs
      // them at once and steers everything else (templates and skills expand).
      if (text.startsWith("/")) void this.request({ type: "prompt", message: text, streamingBehavior: "steer", ...extra }).then(steered);
      else void this.request({ type: "steer", message: text, ...extra }).then(steered);
      return;
    }
    this.casmTurnId = turnId;
    this.running = true;
    this.turnAbort = new AbortController();
    void this.request({ type: "prompt", message: text, ...extra }).then((r) => {
      steered(r);
      const disposition = (r.data as { disposition?: string } | undefined)?.disposition;
      if (!r.success) this.endTurn("failed", String(r.error ?? "prompt rejected"), turnId);
      else if (disposition === "handled") this.endTurn("completed", undefined, turnId);
    });
  }

  // pi runs it, streams bash_execution_update with the command's id and stores
  // a bashExecution message that reaches the model with the next prompt.
  shell(command: string, itemId: string, turnId?: string) {
    const item: Tool = { kind: "tool", id: itemId, name: "shell", origin: "user", input: { command }, status: "running" };
    const id = `casm-${++this.seq}`;
    this.casmTurnId = turnId;
    this.running = true;
    this.turnAbort = new AbortController();
    this.shellRun = { id, item };
    this.opts.emit({ type: "item", item });
    void this.request({ type: "bash", command }, id).then((r) => {
      if (turnId !== this.casmTurnId) return;
      this.shellRun = null;
      if (!r.success) {
        this.opts.emit({ type: "item", item: { ...item, status: "error", output: String(r.error ?? "bash failed") } });
        this.endTurn(this.interrupted ? "interrupted" : "failed", String(r.error ?? "bash failed"), turnId);
        return;
      }
      const d = (r.data ?? {}) as { output?: string; exitCode?: number; cancelled?: boolean };
      this.opts.emit({ type: "item", item: shellItem(itemId, command, d.output, d.exitCode, d.cancelled) });
      this.endTurn(d.cancelled || this.interrupted ? "interrupted" : "completed", undefined, turnId);
    });
  }

  // Runs an extension command (never a model prompt) and returns what it notified.
  private command(text: string): Promise<{ level: string; text: string }[]> {
    const run = this.commandQueue.then(async () => {
      const notes: { level: string; text: string }[] = [];
      const id = `casm-${++this.seq}`;
      this.captured = { id, notes };
      try {
        const r = await this.request({ type: "prompt", message: text }, id);
        if (!r.success) throw new Error(`pi ${text}: ${String(r.error ?? "failed")}`);
        if ((r.data as { disposition?: string } | undefined)?.disposition !== "handled") throw new Error(`pi did not run ${text} as a command`);
        return notes;
      } finally {
        if (this.captured?.id === id) this.captured = null;
      }
    });
    this.commandQueue = run.catch(() => {});
    return run;
  }

  // Only pi's built-in MCP support prints the status parsed here; --no-mcp or
  // an extension that replaces /mcp leaves the manager's reload fallback.
  private async requireBuiltinMcp() {
    this.builtinMcp ??= this.request({ type: "get_commands" }).then((r) =>
      ((r.data as { commands?: PiCommand[] } | undefined)?.commands ?? []).some((c) => c.name === "mcp" && c.sourceInfo?.path === "builtin:mcp"));
    if (!(await this.builtinMcp)) throw Object.assign(new Error("pi's built-in MCP support is not loaded"), { code: -32601 });
  }

  async mcpStatus(): Promise<McpServer[]> {
    await this.requireBuiltinMcp();
    const notes = await this.command("/mcp");
    const failed = notes.find((n) => n.level === "error");
    if (failed) throw new Error(failed.text);
    const status = notes.filter((n) => n.level === "info").at(-1)?.text ?? "";
    return status.startsWith("No MCP servers configured") ? [] : parseMcpStatus(status, this.casmServers);
  }

  // pi reconnects one server per /mcp reconnect; "all" is every enabled one.
  async mcpReconnect(server?: string): Promise<string> {
    await this.requireBuiltinMcp();
    const names = server ? [server] : (await this.mcpStatus()).filter((s) => s.status !== "disabled").map((s) => s.name);
    if (!names.length) return "No enabled MCP server to reconnect.";
    const done: string[] = [];
    for (const name of names) {
      if (!SERVER_NAME.test(name)) throw new Error(`No MCP server named "${name}".`);
      const notes = await this.command(`/mcp reconnect ${name}`);
      const failed = notes.find((n) => n.level === "error" || n.level === "warning");
      if (failed) throw new Error(server ? failed.text : [...done, failed.text].join("\n"));
      done.push(notes.map((n) => n.text).join("\n") || `Reconnected to MCP server "${name}".`);
    }
    return done.join("\n");
  }

  private async toggleMcp(server: string, enabled: boolean) {
    if (!this.casmServers.has(server))
      throw new Error(`pi saves enabling or disabling "${server}" to its mcp.json; casm only toggles the MCP servers it adds to the session. Edit pi's mcp.json (or run /mcp in pi) and reload the agent.`);
    const notes = await this.command(`/${CASM_MCP_COMMAND} ${enabled ? "enable" : "disable"} ${server}`);
    const failed = notes.find((n) => n.level === "error");
    if (failed) throw new Error(failed.text);
  }

  async interrupt() {
    if (!this.running) return;
    this.interrupted = true;
    if (this.shellRun) {
      await this.request({ type: "abort_bash" });
      return;
    }
    // A pending dialog blocks the tool that opened it, and so the abort.
    this.turnAbort.abort();
    await this.request({ type: "clear_queue" });
    await this.request({ type: "abort" });
  }

  async close() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill("SIGTERM"), 3000);
    await exited;
    clearTimeout(timer);
  }
}

export function piProvider(): Provider {
  return {
    id: "pi",
    open: (opts) => new PiSession(opts),
    async history(sessionId) {
      try {
        return parseSession(await readFile(sessionId, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    async historyAliases(sessionId) {
      try {
        return Object.fromEntries(activePath(entriesOf(await readFile(sessionId, "utf8")))
          .filter((e) => e.type === "message" && e.message?.role === "user" && e.message.timestamp !== undefined)
          .map((e) => [e.id!, `pi:${e.message!.timestamp}`]));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw e;
      }
    },
    catalog: fetchCatalog,
    async usage(sessionId) {
      let jsonl: string;
      try {
        jsonl = await readFile(sessionId, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      const known = await contextWindows().catch(() => new Map<string, number>());
      return sessionUsage(jsonl, (provider, model) => known.get(`${provider}/${model}`));
    },
    async costs(sessionId) {
      try {
        return sessionCosts(await readFile(sessionId, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
    },
    // pi appends to the session file, so its size and mtime say when it changed.
    async costStamp(sessionId) {
      const s = await stat(sessionId).catch(() => null);
      return s ? `${s.size}:${s.mtimeMs}` : "missing";
    },
    commands: fetchCommands,
  };
}

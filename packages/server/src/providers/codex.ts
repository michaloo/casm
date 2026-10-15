import { codexMcpServer } from "./mcp.ts";
import { providerEnv } from "./env.ts";
import { toolImages, viewedImage } from "./tool-images.ts";
// Codex via `codex app-server`: JSON-RPC over stdio, one process per open
// session. The native session id is the thread id; history comes from
// `thread/items/list`, which reads Codex's own rollout files.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type {
  Answers,
  AnswerValue,
  Catalog,
  Command,
  ImageData,
  Item,
  ModeInfo,
  ModelInfo,
  PermissionRequest,
  PlanEntry,
  QuestionPrompt,
  QuestionRequest,
  Usage,
  ProviderLimits,
} from "@casm/protocol";
import type { OpenOptions, PermissionAnswer, Provider, ProviderSession } from "./types.ts";
import { codexMemories } from "./codex-memory.ts";
import { limitFromText } from "../limits.ts";
import { isoTime, seen, timed } from "../item-times.ts";


const MAX_TOOL_OUTPUT = 8000;
// History drops image bytes above this (decoded) size; the item keeps the media type.
const MAX_HISTORY_IMAGE = 1024 * 1024;
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

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// An `image` (URL, usually a data: URL) or `localImage` (path) input -> ImageData.
export function inputImage(b: Record<string, unknown>): ImageData | null {
  if (b.type === "image") {
    const url = str(b.url);
    const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
    if (!m) return { mediaType: IMAGE_TYPES[extname(url.split("?")[0]).toLowerCase()] ?? "image/*" };
    return m[2].length * 0.75 > MAX_HISTORY_IMAGE ? { mediaType: m[1] } : { mediaType: m[1], data: m[2] };
  }
  if (b.type === "localImage") {
    const path = str(b.path);
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()] ?? "image/*";
    try {
      if (statSync(path).size <= MAX_HISTORY_IMAGE) return { mediaType, data: readFileSync(path).toString("base64") };
    } catch {
      // Gone since: keep the media type only.
    }
    return { mediaType };
  }
  return null;
}

// A plan item's markdown -> entries, when it is a plain list (Plan mode's
// proposed plan usually is). Checkboxes set the status. Null for prose plans.
export function planEntries(text: string): PlanEntry[] | null {
  const lines = text.split("\n").filter((l) => l.trim());
  const entries: PlanEntry[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX~-])\]\s+)?(.+)$/.exec(line);
    if (!m) return null;
    const mark = m[1];
    entries.push({ text: m[2].trim(), status: mark === "x" || mark === "X" ? "completed" : mark === "~" || mark === "-" ? "in_progress" : "pending" });
  }
  return entries.length ? entries : null;
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
      const content = arr(item.content).map(rec);
      const images: ImageData[] = [];
      const skills = new Set(content.filter((b) => b.type === "skill").map((b) => str(b.name)));
      const text = content
        .flatMap((b): string[] => {
          const image = inputImage(b);
          if (image) return images.push(image), [];
          // casm sends "/name args" as "$name args" plus the skill input: show it as typed.
          if (b.type === "text") return [str(b.text).replace(/^\$([\w:.-]+)/, (all, name: string) => (skills.has(name) ? `/${name}` : all))];
          if (b.type === "skill") return str(content.find((t) => t.type === "text")?.text).startsWith(`$${str(b.name)}`) ? [] : [`/${str(b.name)}`];
          if (b.type === "mention") return [`@${str(b.name)}`];
          return [`[${str(b.type)}]`];
        })
        .join("\n")
        .trim();
      if (!text && !images.length) return null;
      const user: Item = { kind: "user", id: str(item.clientId) || id, text };
      if (images.length) user.images = images;
      return user;
    }
    case "agentMessage":
      return str(item.text).trim() ? { kind: "assistant", id, text: str(item.text) } : null;
    case "plan": {
      // Plan mode's proposed plan. Prose plans stay assistant text.
      const entries = planEntries(str(item.text));
      if (entries) return { kind: "plan", id, entries };
      return str(item.text).trim() ? { kind: "assistant", id, text: str(item.text) } : null;
    }
    case "reasoning": {
      const parts = arr(item.summary).length ? arr(item.summary) : arr(item.content);
      const text = parts.map(str).join("\n\n");
      return text.trim() ? { kind: "reasoning", id, text } : null;
    }
    case "commandExecution": {
      let output = str(item.aggregatedOutput);
      if (item.status === "declined" && !output) output = "Declined by the user.";
      return { ...tool(item, "shell", { command: unwrapShell(str(item.command)), cwd: item.cwd }, status, output), ...(item.source === "userShell" ? { origin: "user" as const } : {}) };
    }
    case "fileChange": {
      const changes = arr(item.changes).map(rec);
      const input = { changes: changes.map((c) => ({ path: str(c.path), kind: str(rec(c.kind).type || c.kind) })) };
      const output = item.status === "declined" ? "Declined by the user." : changes.map((c) => `${str(c.path)}\n${str(c.diff)}`).join("\n");
      return tool(item, "edit", input, status, output);
    }
    case "mcpToolCall": {
      const output = item.error ? str(rec(item.error).message) : item.result ? contentText(rec(item.result).content) : "";
      return { ...tool(item, `mcp__${str(item.server)}__${str(item.tool)}`, item.arguments, status, output), ...toolImages(rec(item.result).content) };
    }
    case "dynamicToolCall":
      return { ...tool(item, str(item.tool), item.arguments, status, contentText(item.contentItems)), ...toolImages(item.contentItems) };
    case "collabAgentToolCall":
    case "subAgentActivity":
      return subagentItems(item)[0] ?? null;
    case "functionCallOutput":
      return { ...tool(item, str(item.name) || "tool", undefined, "done", typeof item.output === "string" ? item.output : contentText(item.output)), ...toolImages(item.output) };
    case "webSearch":
      return tool(item, "web_search", { query: item.query, action: item.action }, status);
    // Image generation (codex-rs/ext/items image_generation.rs): `result` is the
    // base64 image, `savedPath` its file. Over 1 MB it stays a path, never input.
    case "imageGeneration": {
      const image = toolImages([{ type: "image", data: str(item.result) }]).images?.[0] ?? viewedImage(item.savedPath);
      const failure = str(rec(item.failure).type);
      const output = failure ? `Image generation failed: ${failure}` : str(item.savedPath) ? `Saved to ${str(item.savedPath)}` : "";
      return { ...tool(item, "image_generation", { prompt: str(item.revisedPrompt) }, status, output), ...(image ? { images: [image] } : {}) };
    }
    case "imageView": {
      const image = viewedImage(item.path);
      return { ...tool(item, "view_image", { path: item.path }, status), ...(image ? { images: [image] } : {}) };
    }
    case "contextCompaction":
      return { kind: "notice", id, text: "Context compacted", level: "info" };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { kind: "notice", id, text: `${item.type === "enteredReviewMode" ? "Review started" : "Review finished"}: ${str(item.review)}`, level: "info" };
    case "hookPrompt":
      return null;
    default: {
      const { type, id: _id, status: _s, ...rest } = item;
      return tool(item, type, rest, status);
    }
  }
}

type SubagentItem = Extract<Item, { kind: "subagent" }>;

function childStatus(status: unknown): SubagentItem["status"] {
  if (["errored", "interrupted", "notFound", "failed"].includes(str(status))) return "error";
  return status === "completed" || status === "shutdown" ? "done" : "running";
}

// Calls can address several children. Never use the call/notice id as a child id.
export function subagentItems(raw: CodexItem, known = new Map<string, SubagentItem>()): SubagentItem[] {
  if (raw.type !== "collabAgentToolCall" && raw.type !== "subAgentActivity") return [];
  const states = rec(raw.agentsStates);
  const ids = raw.type === "subAgentActivity" ? [str(raw.agentThreadId)] : [...arr(raw.receiverThreadIds).map(str), ...Object.keys(states)];
  return [...new Set(ids)].filter(Boolean).map((id) => {
    const previous = known.get(id);
    const state = rec(states[id]);
    const nativeStatus = raw.type === "subAgentActivity" ? raw.kind : state.status;
    const item: SubagentItem = {
      kind: "subagent", id, title: previous?.title ?? (str(raw.agentPath) || str(raw.prompt) || "Subagent"),
      ...previous,
      status: nativeStatus ? childStatus(nativeStatus) : previous?.status ?? "running",
    };
    if (raw.agentPath) item.title = str(raw.agentPath);
    if (state.message) item.summary = truncate(str(state.message));
    return item;
  });
}

// The reducer is shared by paginated history and live collaboration snapshots.
function normalizeItems(raw: CodexItem, known: Map<string, SubagentItem>, live = false): Item[] {
  if (raw.type === "collabAgentToolCall" || raw.type === "subAgentActivity") {
    const items = subagentItems(raw, known);
    for (const item of items) known.set(item.id, item);
    return items;
  }
  const item = normalize(raw, live);
  return item ? [item] : [];
}

type Limits = Omit<ProviderLimits, "provider" | "updatedAt">;

export function rateLimits(snapshot: unknown): Limits {
  const s = rec(snapshot);
  const windows: Limits["windows"] = [];
  for (const id of ["primary", "secondary"]) {
    if (!s[id]) continue;
    const w = rec(s[id]);
    const minutes = typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined;
    const used = typeof w.usedPercent === "number" ? w.usedPercent : undefined;
    const label = minutes === 10080 ? "weekly" : minutes === 1440 ? "daily" : minutes && minutes % 60 === 0 ? `${minutes / 60}-hour` : minutes ? `${minutes}-minute` : id;
    windows.push({ id: s.limitId ? `${str(s.limitId)}:${id}` : id, label,
      ...(used !== undefined ? { usedPercent: used } : {}),
      ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
      ...(typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
      status: s.rateLimitReachedType || (used ?? 0) >= 100 ? "exhausted" : (used ?? 0) >= 80 ? "warning" : "ok",
    });
  }
  if (!windows.length && s.rateLimitReachedType) windows.push({ id: str(s.limitId) || "usage", status: "exhausted" });
  return { ...(s.planType ? { plan: str(s.planType) } : {}), windows };
}

export async function readLimits(): Promise<Limits> {
  const rpc = new Rpc(homedir(), providerEnv());
  try {
    await rpc.initialize();
    const response = await rpc.request("account/rateLimits/read", {});
    const buckets = Object.entries(rec(response.rateLimitsByLimitId)).filter(([, value]) => value != null);
    if (!buckets.length) return rateLimits(response.rateLimits);
    const mapped = buckets.map(([id, value]) => rateLimits({ ...rec(value), limitId: rec(value).limitId ?? id }));
    const plan = rateLimits(response.rateLimits).plan ?? mapped.find((limits) => limits.plan)?.plan;
    return { ...(plan ? { plan } : {}), windows: mapped.flatMap((limits) => limits.windows) };
  } finally {
    rpc.kill();
  }
}

// --- notices, plans, usage (live notifications)

// This records input sent to a PTY, not the completion of its owning command.
// Each notification gets its own ID: sending the same keystroke twice is valid.
export function terminalInteraction(p: Record<string, unknown>, id: string, command?: string): ToolItem | null {
  if (typeof p.processId !== "string" || !p.processId || typeof p.itemId !== "string" || !p.itemId || typeof p.stdin !== "string") return null;
  return {
    kind: "tool", id, name: "terminal", status: "done",
    input: { processId: p.processId, itemId: p.itemId, stdin: truncate(p.stdin), ...(command ? { command: truncate(command) } : {}) },
    ...(p.stdin === "" ? { output: "No input sent." } : {}),
  };
}

const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// Codex wraps API errors as JSON text: show the inner message.
export function errorMessage(error: unknown): string {
  const raw = str(rec(error).message);
  try {
    const inner = rec(rec(JSON.parse(raw)).error).message;
    if (typeof inner === "string" && inner) return inner;
  } catch {
    // Plain text.
  }
  return raw;
}

// `error`: a retry (willRetry) updates one warning per turn in place; a final
// error is an error notice (the turn then fails with the same message).
export function errorNotice(p: Record<string, unknown>): Item {
  const turn = str(p.turnId);
  const message = errorMessage(p.error);
  if (p.willRetry) return { kind: "notice", id: `retry-${turn}`, text: `Retrying: ${message}`, level: "warning" };
  return { kind: "notice", id: `error-${turn}`, text: message, level: "error" };
}

// warning, guardianWarning, configWarning, deprecationNotice. Same text, same id.
export function warningNotice(method: string, p: Record<string, unknown>): Item {
  const text = method === "configWarning" || method === "deprecationNotice" ? [str(p.summary), str(p.details)].filter(Boolean).join("\n") : str(p.message);
  const level = method === "deprecationNotice" ? "info" : "warning";
  return { kind: "notice", id: `${method}-${shortHash(text)}`, text, level };
}

const PLAN_STATUS: Record<string, PlanEntry["status"]> = { pending: "pending", inProgress: "in_progress", completed: "completed" };

// turn/plan/updated (the update_plan tool): one plan per turn, replaced on each update.
export function planUpdate(p: Record<string, unknown>): Item {
  const entries = arr(p.plan).map((raw) => ({ text: str(rec(raw).step), status: PLAN_STATUS[str(rec(raw).status)] ?? "pending" }));
  return { kind: "plan", id: `plan-${str(p.turnId)}`, entries };
}

// thread/tokenUsage/updated -> Usage. Context is the last request's total (its
// input already includes cached tokens); input/output are the thread totals.
// Codex reports no cost.
export function tokenUsage(tokenUsage: unknown, model?: string): Usage {
  const t = rec(tokenUsage);
  const last = rec(t.last);
  const total = rec(t.total);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const u: Usage = {
    contextTokens: num(last.totalTokens),
    contextWindow: num(t.modelContextWindow) ?? undefined,
    inputTokens: num(total.inputTokens),
    outputTokens: num(total.outputTokens),
  };
  if (model) u.model = model;
  for (const k of Object.keys(u) as (keyof Usage)[]) if (u[k] === undefined) delete u[k];
  return u;
}

// The same from a rollout file: the last `token_count` event, the last
// `turn_context` model.
export function rolloutUsage(jsonl: string): Usage | null {
  let info: Record<string, unknown> | null = null;
  let model = "";
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec(o.payload);
    if (o.type === "turn_context" && p.model) model = str(p.model);
    if (o.type === "event_msg" && p.type === "token_count" && p.info) info = rec(p.info);
  }
  if (!info) return model ? { model } : null;
  const b = (v: unknown) => {
    const x = rec(v);
    return { totalTokens: x.total_tokens, inputTokens: x.input_tokens, outputTokens: x.output_tokens };
  };
  return tokenUsage({ last: b(info.last_token_usage), total: b(info.total_token_usage), modelContextWindow: info.model_context_window }, model || undefined);
}

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

// sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl (or archived_sessions/).
async function findRollout(threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Newest first: date directories sort lexically.
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) return join(dir, e.name);
      if (e.isDirectory() && depth < 3) {
        const hit = await walk(join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return (await walk(join(codexHome(), "sessions"), 0)) ?? (await walk(join(codexHome(), "archived_sessions"), 0));
}

export async function readUsage(sessionId: string): Promise<Usage | null> {
  const file = await findRollout(sessionId);
  if (!file) return null;
  return rolloutUsage(await readFile(file, "utf8"));
}

// --- commands

// casm-routed Codex commands: the app-server has a request for each.
export const BUILTIN_COMMANDS: Command[] = [
  { name: "compact", description: "Summarize the conversation to free up context.", kind: "command" },
  { name: "review", description: "Review uncommitted changes, or what the instructions say.", argumentHint: "[instructions]", kind: "command" },
];

export type Skill = { name: string; path: string; description: string };

// skills/list -> enabled skills, deduplicated by name (first scope wins).
export function parseSkills(res: unknown): Skill[] {
  const seen = new Map<string, Skill>();
  for (const entry of arr(rec(res).data))
    for (const raw of arr(rec(entry).skills)) {
      const s = rec(raw);
      const name = str(s.name);
      if (!name || s.enabled === false || seen.has(name)) continue;
      const description = str(rec(s.interface).shortDescription) || str(s.shortDescription) || str(s.description);
      seen.set(name, { name, path: str(s.path), description });
    }
  return [...seen.values()];
}

export function skillCommands(skills: Skill[]): Command[] {
  return skills.map((s) => ({ name: s.name, description: s.description || undefined, kind: "skill" }));
}

// What a prompt starting with "/name" does: a builtin request, a skill
// invocation (the CLI's "$name" text plus a skill input), or plain text.
export type Routed = { kind: "compact" } | { kind: "review"; instructions: string } | { kind: "input"; input: Record<string, unknown>[] };

// Text plus images (as data: URLs, which Codex passes to the model as is).
export function promptInput(text: string, images: ImageData[] = [], extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const imageInputs = images.filter((i) => i.data).map((i) => ({ type: "image", url: `data:${i.mediaType};base64,${i.data}` }));
  return [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...extra, ...imageInputs];
}

export function routePrompt(text: string, skills: Skill[], images: ImageData[] = []): Routed {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const plain = (t: string, extra: Record<string, unknown>[] = []) => ({ kind: "input" as const, input: promptInput(t, images, extra) });
  if (!m) return plain(text);
  const [, name, args = ""] = m;
  if (name === "compact" && !args.trim() && !images.length) return { kind: "compact" };
  if (name === "review" && !images.length) return { kind: "review", instructions: args.trim() };
  const skill = skills.find((s) => s.name === name);
  if (skill) return plain(`$${name}${args ? ` ${args}` : ""}`, [{ type: "skill", name, path: skill.path }]);
  return plain(text);
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
      if (m.error) p?.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
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

// Paseo's Codex modes plus Plan. Same order as the catalog.
export const MODE_INFO: ModeInfo[] = [
  { id: "plan", name: "Plan mode", description: "Codex's Plan collaboration mode: explores and asks questions, then proposes a plan without editing files." },
  { id: "auto", name: "Codex defaults", description: "No overrides: sandbox and approvals come from your ~/.codex/config.toml (and Codex's built-in defaults)." },
  {
    id: "auto-review",
    name: "Auto-review",
    description: "Workspace-write sandbox with on-request approvals routed through the auto-reviewer subagent.",
  },
  { id: "full-access", name: "Full access", description: "Edit files, run commands, and access the network without additional prompts." },
];

export async function readCatalog(): Promise<Catalog> {
  const rpc = new Rpc(homedir(), providerEnv());
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

// casm mode -> Codex permissions + collaboration mode. Plan keeps Default's
// permissions (as Paseo's plan toggle and the Codex CLI do); Codex's Plan
// instructions keep it from editing. "auto", an unset or an unknown mode is
// Default collaboration with the user's own config.toml permissions: casm
// applies no sandbox or approval overrides of its own.
type ModePreset = { approvalPolicy: string; sandbox: string; approvalsReviewer: "user" | "auto_review"; collaboration: "plan" | "default" };
export const MODES: Record<string, ModePreset> = {
  plan: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user", collaboration: "plan" },
  "auto-review": { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", collaboration: "default" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user", collaboration: "default" },
};

// A `collaborationMode/list` preset (CollaborationModeMask).
export type CollaborationPreset = { name: string; mode: string | null; model: string | null; reasoning_effort: string | null };

// `turn/start` collaborationMode. It takes precedence over the turn's model and
// effort, so it carries the agent's (or else the thread's) model and effort; the
// preset's effort applies when the agent sets none (Plan: medium). Null
// developer_instructions keeps Codex's built-in instructions for the mode; the
// agent's systemPrompt goes in as the thread's developerInstructions.
export function collaborationMode(
  kind: "plan" | "default",
  presets: CollaborationPreset[],
  agent: { model?: string; effort?: string },
  thread: { model: string; effort: string | null },
): { mode: "plan" | "default"; settings: { model: string; reasoning_effort: string | null; developer_instructions: null } } {
  const preset = presets.find((p) => p.mode === kind) ?? presets.find((p) => p.name.toLowerCase() === kind);
  return {
    mode: kind,
    settings: {
      model: agent.model || preset?.model || thread.model,
      reasoning_effort: agent.effort || preset?.reasoning_effort || thread.effort,
      developer_instructions: null,
    },
  };
}

type Decision = "accept" | "acceptForSession" | "decline" | "cancel" | Record<string, unknown>;

class CodexSession implements ProviderSession {
  private rpc: Rpc;
  private opts: OpenOptions;
  private threadId: string | null = null;
  private thread = { model: "", effort: null as string | null };
  private presets: CollaborationPreset[] = [];
  private turnId: string | null = null;
  private ended = new Set<string>();
  private casmTurnId?: string;
  private turnOwners = new Map<string, string | undefined>();
  // Serializes startup, turn/start, steer and interrupt.
  private chain: Promise<unknown>;
  private approvals = new Map<string, AbortController>();
  // Tool items seen in this turn, so approvals can show what they approve.
  private tools = new Map<string, Item>();
  // PTYs can span turns. Retain a bounded command lookup for their input cards.
  private terminalCommands = new Map<string, string>();
  private terminalSequence = 0;
  private closing = false;
  private subagents = new Map<string, SubagentItem>();
  private limitSnapshots = new Map<string, Record<string, unknown>>();
  // For "/skill" prompts; refreshed on skills/changed.
  private skills: Skill[] = [];
  private model = "";
  // A thread/shellCommand was sent and its turn has not started yet.
  private shellPending = false;

  constructor(opts: OpenOptions) {
    this.opts = opts;
    this.rpc = new Rpc(opts.cwd, providerEnv(opts.config.env));
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
    if (resumeId) {
      for (const item of await readHistory(resumeId, cwd)) if (item.kind === "subagent") this.subagents.set(item.id, item);
    }
    const mode = config.mode ? MODES[config.mode] : undefined;
    const params = {
      cwd,
      model: config.model,
      approvalPolicy: mode?.approvalPolicy,
      sandbox: mode?.sandbox,
      approvalsReviewer: mode?.approvalsReviewer,
      developerInstructions: config.systemPrompt,
      // Reasoning summaries feed Thinking rows; Codex models default to none.
      config: { model_reasoning_summary: "detailed", ...(config.mcpServers ? { mcp_servers: config.mcpServers } : {}) },
    };
    type ThreadResponse = { thread: { id: string }; model: string; reasoningEffort: string | null };
    const res = resumeId
      ? await this.rpc.request<ThreadResponse>("thread/resume", { ...params, threadId: resumeId, excludeTurns: true })
      : await this.rpc.request<ThreadResponse>("thread/start", params);
    this.threadId = res.thread.id;
    this.thread = { model: str(res.model), effort: res.reasoningEffort ?? null };
    this.model = config.model || str(res.model);
    // Unset config.model means Codex's own default (config.toml), not the catalog's.
    if (this.model) this.opts.emit({ type: "model", model: this.model });
    try {
      this.presets = (await this.rpc.request<{ data: CollaborationPreset[] }>("collaborationMode/list", {})).data;
    } catch {
      // Older Codex: fall back to the bare mode kinds.
    }
    await this.loadSkills();
    this.opts.emit({ type: "sessionId", id: res.thread.id });
  }

  private async loadSkills() {
    try {
      this.skills = parseSkills(await this.rpc.request("skills/list", { cwds: [this.opts.cwd] }));
    } catch {
      // Older Codex: no skills.
    }
  }

  private onNotification(method: string, p: Record<string, unknown>) {
    const { emit } = this.opts;
    if (method === "account/rateLimits/updated") {
      // Rolling updates are sparse: null metadata does not clear known values.
      const update = rec(p.rateLimits);
      const bucket = str(update.limitId);
      const snapshot = this.limitSnapshots.get(bucket) ?? {};
      for (const [key, value] of Object.entries(update)) {
        if (value == null) continue;
        snapshot[key] = key === "primary" || key === "secondary"
          ? { ...rec(snapshot[key]), ...Object.fromEntries(Object.entries(rec(value)).filter(([, v]) => v != null)) }
          : value;
      }
      if ("rateLimitReachedType" in update) snapshot.rateLimitReachedType = update.rateLimitReachedType;
      this.limitSnapshots.set(bucket, snapshot);
      const mapped = [...this.limitSnapshots.values()].map(rateLimits);
      const plan = mapped.find((limits) => limits.plan)?.plan;
      emit({ type: "limits", limits: { ...(plan ? { plan } : {}), windows: mapped.flatMap((limits) => limits.windows) } });
      return;
    }
    if (method === "thread/started") {
      const thread = rec(p.thread);
      if (this.threadId && thread.parentThreadId === this.threadId && thread.id) {
        const id = str(thread.id);
        this.publishChild({ kind: "subagent", id, title: str(thread.agentNickname) || "Subagent", status: "running",
          ...(thread.agentRole ? { agentType: str(thread.agentRole) } : {}), ...this.subagents.get(id) });
      }
      return;
    }
    if (p.threadId != null && p.threadId !== this.threadId) {
      this.childNotification(method, p);
      return;
    }
    switch (method) {
      case "error": {
        emit({ type: "item", item: errorNotice(p) });
        const err = rec(p.error);
        const info = err.codexErrorInfo;
        if (!p.willRetry && (info === "usageLimitExceeded" || info === "rateLimitExceeded")) {
          const hit = limitFromText(str(err.message));
          emit({
            type: "limits",
            limits: { windows: [{ id: "usage", label: info === "usageLimitExceeded" ? "usage limit" : "rate limit", status: "exhausted", resetsAt: hit?.resetsAt }] },
          });
        }
        return;
      }
      case "warning":
      case "guardianWarning":
      case "configWarning":
      case "deprecationNotice":
        emit({ type: "item", item: warningNotice(method, p) });
        return;
      case "model/rerouted":
        this.model = str(p.toModel);
        emit({ type: "item", item: { kind: "notice", id: `reroute-${str(p.turnId)}`, text: `Model rerouted from ${str(p.fromModel)} to ${str(p.toModel)}`, level: "warning" } });
        emit({ type: "usage", usage: { model: this.model } });
        if (this.model) emit({ type: "model", model: this.model });
        return;
      case "thread/settings/updated": {
        const model = str(rec(p.threadSettings).model);
        if (model && model !== this.model) (this.model = model), emit({ type: "model", model });
        return;
      }
      case "skills/changed":
        void this.loadSkills();
        return;
      case "turn/plan/updated":
        emit({ type: "item", item: planUpdate(p) });
        return;
      case "thread/tokenUsage/updated":
        emit({ type: "usage", usage: tokenUsage(p.tokenUsage, this.model) });
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        if (str(p.delta)) emit({ type: "toolOutput", itemId: str(p.itemId), text: str(p.delta) });
        return;
      case "item/commandExecution/terminalInteraction": {
        if (!this.turnId || p.turnId !== this.turnId || this.ended.has(this.turnId)) return;
        const item = terminalInteraction(p, `terminal:${this.turnId}:${++this.terminalSequence}`, this.terminalCommands.get(str(p.processId)));
        if (item) emit({ type: "item", item });
        return;
      }
      case "item/mcpToolCall/progress":
        if (str(p.message)) emit({ type: "toolOutput", itemId: str(p.itemId), text: `${str(p.message)}\n` });
        return;
      case "turn/started": {
        const id = str(rec(p.turn).id);
        if (!this.ended.has(id)) {
          this.turnId = id;
          this.turnOwners.set(id, this.casmTurnId);
        }
        this.shellPending = false;
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
        if (raw.type === "commandExecution" && typeof raw.processId === "string" && raw.processId && typeof raw.command === "string") {
          this.terminalCommands.set(raw.processId, unwrapShell(raw.command));
          if (this.terminalCommands.size > 256) this.terminalCommands.delete(this.terminalCommands.keys().next().value!);
        }
        for (const item of normalizeItems(raw, this.subagents, method === "item/started")) {
          if (item.kind === "tool") this.tools.set(item.id, item);
          // Text arrives as deltas; the full item lands on completion.
          if (method === "item/completed" || item.kind === "tool" || item.kind === "notice" || item.kind === "subagent") emit({ type: "item", item });
        }
        return;
      }
      case "serverRequest/resolved":
        this.approvals.get(str(p.requestId))?.abort();
        return;
      case "turn/completed": {
        const turn = rec(p.turn);
        const id = str(turn.id);
        if (this.ended.has(id)) return;
        this.ended.add(id);
        if (this.turnId && this.turnId !== id) return;
        const owner = this.turnOwners.get(id) ?? this.casmTurnId;
        this.turnOwners.delete(id);
        if (this.turnId === id) this.turnId = null;
        this.shellPending = false;
        this.abortApprovals();
        const status = str(turn.status);
        for (const t of this.tools.values())
          if (t.kind === "tool" && t.status === "running")
            emit({ type: "item", item: { ...t, status: "error", output: status === "interrupted" ? "Interrupted." : "Did not finish." } });
        this.tools.clear();
        const outcome = status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
        const error = outcome === "failed" ? errorMessage(turn.error) || "turn failed" : undefined;
        emit({ type: "turnEnded", outcome, error, ...(owner ? { turnId: owner } : {}) });
        return;
      }
    }
  }

  private publishChild(item: SubagentItem) {
    this.subagents.set(item.id, item);
    this.opts.emit({ type: "item", item });
  }

  private childNotification(method: string, p: Record<string, unknown>) {
    const previous = this.subagents.get(str(p.threadId));
    if (!previous) return; // Unrelated threads must not enter this transcript.
    const item = { ...previous };
    if (method === "turn/started") item.status = "running";
    else if (method === "turn/completed") item.status = childStatus(rec(p.turn).status);
    else if (method === "error" && !p.willRetry) { item.status = "error"; item.summary = errorMessage(p.error); }
    else if (method === "thread/tokenUsage/updated") item.usage = tokenUsage(p.tokenUsage);
    else if (method === "item/started" || method === "item/completed") {
      const raw = rec(p.item) as CodexItem;
      const normalized = normalize(raw, method === "item/started");
      item.activity = normalized?.kind === "tool" ? normalized.name : raw.type;
      if (method === "item/completed" && raw.type === "agentMessage") item.summary = truncate(str(raw.text));
    } else return;
    this.publishChild(item);
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
        // URL mode: the server wants the user to open a page (sign in, pay, consent).
        if (p.mode === "url") {
          const a = await this.ask(key, { toolName: `mcp__${str(p.serverName)}`, input: { message: p.message, url: p.url }, title: `${str(p.message)} ${str(p.url)}`.trim(), canAlwaysAllow: false }, str(p.elicitationId));
          return { action: a && a.decision !== "deny" ? "accept" : "decline", content: null, _meta: null };
        }
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

  private enqueue(fn: () => Promise<void>, turnId = this.casmTurnId) {
    this.chain = this.chain.then(fn).catch((e: unknown) => {
      this.opts.emit({ type: "turnEnded", outcome: "failed", error: e instanceof Error ? e.message : String(e), ...(turnId ? { turnId } : {}) });
    });
    return this.chain;
  }

  send(text: string, itemId: string, images?: ImageData[], turnId?: string) {
    this.casmTurnId = turnId;
    void this.enqueue(async () => {
      if (!this.threadId) return; // startup failed; `closed` was emitted
      const routed = routePrompt(text, this.skills, images);
      // Builtins can't join a running turn: steer them in as text.
      const input = routed.kind === "input" ? routed.input : promptInput(text, images);
      if (this.turnId) {
        try {
          await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input, clientUserMessageId: itemId });
          return;
        } catch {
          // The turn ended in between: start a new one instead.
        }
      }
      if (routed.kind === "compact") {
        // Runs as its own turn (turn/started, contextCompaction, turn/completed).
        await this.rpc.request("thread/compact/start", { threadId: this.threadId });
        return;
      }
      if (routed.kind === "review") {
        const target = routed.instructions ? { type: "custom", instructions: routed.instructions } : { type: "uncommittedChanges" };
        const res = await this.rpc.request<{ turn: { id: string; status: string } }>("review/start", { threadId: this.threadId, target });
        if (res.turn.status === "inProgress" && !this.ended.has(res.turn.id)) this.turnId = res.turn.id;
        return;
      }
      const { config } = this.opts;
      const res = await this.rpc.request<{ turn: { id: string; status: string } }>("turn/start", {
        threadId: this.threadId,
        input,
        clientUserMessageId: itemId,
        model: config.model,
        effort: config.effort,
        // Sent on every turn: a resumed thread keeps whatever mode it last ran in.
        collaborationMode: collaborationMode(MODES[config.mode ?? ""]?.collaboration ?? "default", this.presets, config, this.thread),
      });
      if (res.turn.status === "inProgress" && !this.ended.has(res.turn.id)) this.turnId = res.turn.id;
    });
  }

  // thread/shellCommand runs the command as its own turn (turn/started, a
  // commandExecution item with source "userShell" and streamed output,
  // turn/completed) and records it in the thread, so the model sees it. The
  // item id is Codex's own.
  shell(command: string, _itemId: string, turnId?: string) {
    this.casmTurnId = turnId;
    void this.enqueue(async () => {
      if (!this.threadId) return;
      this.shellPending = true;
      try {
        await this.rpc.request("thread/shellCommand", { threadId: this.threadId, command });
      } catch (e) {
        this.shellPending = false;
        throw e;
      }
    });
  }

  readonly mcpReconnectScope = "all" as const;

  async mcpStatus() {
    await this.chain;
    if (!this.threadId || this.closing) throw new Error("Codex session is not available");
    const servers: import("@casm/protocol").McpServer[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Record<string, unknown>[]; nextCursor?: string | null } = await this.rpc.request("mcpServerStatus/list", { threadId: this.threadId, detail: "toolsAndAuthOnly", cursor });
      servers.push(...page.data.map(codexMcpServer));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return servers;
  }

  async mcpReconnect(_server?: string) {
    await this.chain;
    if (!this.threadId || this.closing) throw new Error("Codex session is not available");
    await this.rpc.request("config/mcpServer/reload", null);
    return "Reloaded all Codex MCP configuration; loaded threads apply the refresh on their next active turn. Codex does not expose per-server reconnect.";
  }

  async interrupt() {
    await this.enqueue(async () => {
      // The shell command's turn is announced after the request returns.
      for (let i = 0; i < 40 && this.shellPending && !this.turnId; i++) await new Promise((r) => setTimeout(r, 50));
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

// Errors of failed turns: the only notices the native store keeps (retries
// and warnings are not persisted).
async function failedTurns(rpc: Rpc, threadId: string): Promise<Map<string, Item>> {
  const out = new Map<string, Item>();
  let cursor: string | null = null;
  try {
    do {
      const page: { data: { id: string; status: string; error?: unknown; completedAt?: number | null }[]; nextCursor: string | null } = await rpc.request("thread/turns/list", {
        threadId,
        cursor,
        itemsView: "notLoaded",
        limit: 200,
      });
      for (const t of page.data)
        if (t.status === "failed" && t.error) {
          const at = t.completedAt ? isoTime(t.completedAt * 1000) : undefined;
          out.set(t.id, { kind: "notice", id: `error-${t.id}`, ...(at ? { at } : {}), text: errorMessage(t.error), level: "error" });
        }
      cursor = page.nextCursor;
    } while (cursor);
  } catch {
    // Older Codex: no turn list.
  }
  return out;
}

export async function readHistory(sessionId: string, cwd: string): Promise<Item[]> {
  const rpc = new Rpc(cwd, providerEnv());
  try {
    await rpc.initialize();
    const byId = new Map<string, Item>();
    const subagents = new Map<string, SubagentItem>();
    // Last item id of each turn, to place a failed turn's error after it.
    const lastOfTurn = new Map<string, string>();
    let cursor: string | null = null;
    do {
      const page: { data: { item: CodexItem; turnId?: string; startedAtMs?: number | null; completedAtMs?: number | null }[]; nextCursor: string | null } = await rpc.request("thread/items/list", {
        threadId: sessionId,
        cursor,
        limit: 500,
      });
      for (const { item, turnId, startedAtMs, completedAtMs } of page.data) {
        for (const raw of normalizeItems(item, subagents)) {
          const prev = byId.get(raw.id);
          const it = timed(prev && seen(prev), raw, isoTime(startedAtMs ?? completedAtMs), isoTime(completedAtMs));
          byId.set(it.id, it);
          if (turnId) lastOfTurn.set(turnId, it.id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    const errors = await failedTurns(rpc, sessionId);
    if (!errors.size) return [...byId.values()];
    const out: Item[] = [];
    const after = new Map([...lastOfTurn].map(([turn, item]) => [item, turn]));
    for (const it of byId.values()) {
      out.push(it);
      const turn = after.get(it.id);
      if (turn && errors.has(turn)) out.push(errors.get(turn)!);
    }
    return out;
  } finally {
    rpc.kill();
  }
}

export async function readCommands(cwd: string): Promise<Command[]> {
  const rpc = new Rpc(cwd, providerEnv());
  try {
    await rpc.initialize();
    return [...BUILTIN_COMMANDS, ...skillCommands(parseSkills(await rpc.request("skills/list", { cwds: [cwd] })))];
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
    limits: readLimits,
    subagentHistory: async (sessionId, cwd, subagentId) => {
      const parent = await readHistory(sessionId, cwd);
      if (!parent.some((item) => item.kind === "subagent" && item.id === subagentId)) throw new Error("Unknown Codex subagent");
      return readHistory(subagentId, cwd);
    },
    usage: (sessionId) => readUsage(sessionId),
    commands: readCommands,
    // Read-only: Codex regenerates its memory files itself.
    memories: codexMemories,
  };
}

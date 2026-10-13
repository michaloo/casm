// Claude Code via the Claude Agent SDK: one long-lived query() per open
// session, fed by an async input queue. History comes from Claude's own JSONL.
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type ModelInfo as SdkModelInfo,
  type ModelUsage as SdkModelUsage,
  type OnElicitation,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Answers,
  AnswerValue,
  Catalog,
  Command,
  ImageData,
  Item,
  ModeInfo,
  ModelInfo,
  PlanEntry,
  QuestionPrompt,
  QuestionRequest,
  Usage,
} from "@casm/protocol";
import type { OpenOptions, Provider, ProviderSession } from "./types.ts";
import { claudeMemories } from "./claude-memory.ts";
import { ClaudeTasks } from "./claude-tasks.ts";

const MAX_TOOL_OUTPUT = 8000;
const MAX_TOOL_INPUT_PREVIEW = 8000;
// History drops image bytes above this (base64 length of ~1 MB of data).
const MAX_HISTORY_IMAGE_B64 = Math.ceil((1024 * 1024 * 4) / 3);
const CATALOG_TIMEOUT_MS = 30_000;
// supportedModels() lists this pseudo-model first; open() passes no model for it.
const DEFAULT_MODEL = "default";

// --- normalization (shared by history and live events)

type Block = { type: string; [k: string]: unknown };
type ToolItem = Extract<Item, { kind: "tool" }>;
type PlanItem = Extract<Item, { kind: "plan" }>;
type NoticeLevel = "info" | "warning" | "error";

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

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function compactNotice(id: string, trigger?: string, pre?: number, post?: number): Item {
  const sizes = pre ? ` (${kTokens(pre)}${post ? ` → ${kTokens(post)}` : ""} tokens)` : "";
  return { kind: "notice", id, level: "info", text: `${trigger === "auto" ? "Context auto-compacted" : "Conversation compacted"}${sizes}` };
}

// Slash commands are stored as XML-ish markup; show them the way they were typed.
function commandText(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
}

const STDOUT = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/;

// Bash mode (`!cmd`): Claude stores the command as `<bash-input>` and its
// result as `<bash-stdout>`/`<bash-stderr>` (plus `<bash-exit-code>` from
// headless runs) in user messages, after a `<local-command-caveat>` that tells
// the model the user ran it. casm stores the same, in one message.
const CAVEAT = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g;
const CAVEAT_TEXT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>\s*/;
const BASH_OUTPUT = /^<bash-(?:stdout|stderr|exit-code)>/;
// Bash output Claude keeps in the transcript (its own shell output cap).
const MAX_BASH_RECORD = 30_000;

const tagged = (text: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(text)?.[1];

// The result part of a bash-mode record -> tool output and status.
export function bashResult(text: string): { output: string; status: "done" | "error" } {
  const exit = tagged(text, "bash-exit-code")?.trim();
  const output = [tagged(text, "bash-stdout"), tagged(text, "bash-stderr")].filter((s) => s?.trim()).join("\n");
  return { output: toolOutput(output), status: exit && exit !== "0" ? "error" : "done" };
}

function capRecord(text: string): string {
  return text.length > MAX_BASH_RECORD ? `…(truncated)\n${text.slice(-MAX_BASH_RECORD)}` : text;
}

// The transcript record of a user shell command, as text blocks.
export function bashRecord(command: string, stdout: string, stderr: string, exitCode: number): { type: "text"; text: string }[] {
  const exit = exitCode !== 0 ? `<bash-exit-code>${exitCode}</bash-exit-code>` : "";
  return [
    { type: "text", text: CAVEAT_TEXT },
    { type: "text", text: `<bash-input>${command}</bash-input>` },
    { type: "text", text: `<bash-stdout>${capRecord(stdout.trimEnd())}</bash-stdout><bash-stderr>${capRecord(stderr.trimEnd())}</bash-stderr>${exit}` },
  ];
}

// A transcript entry: an SDK message (live) or a JSONL line (history).
export type Entry = {
  type: string;
  uuid?: string;
  subtype?: string;
  message?: unknown;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  error?: unknown;
  toolUseResult?: unknown;
  tool_use_result?: unknown;
  content?: unknown;
  level?: string;
  tool_use_id?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  retryAttempt?: number;
  maxRetries?: number;
};

type TaskCall = { tool: "TaskCreate" | "TaskUpdate" | "TodoWrite"; input: Record<string, unknown> };
const PLAN_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
const PLAN_STATUS = new Set(["pending", "in_progress", "completed"]);

// Turns transcript entries into items. Stateful: tool_use items wait for their
// tool_result, and TaskCreate/TaskUpdate/TodoWrite calls build a plan item
// (the raw tool items are hidden). Items are returned again when they change,
// so callers upsert by id.
export class Normalizer {
  readonly tools = new Map<string, ToolItem>();
  private inputStreams = new Map<number, { id: string; json: string; truncated: boolean; emitted: number }>();
  private draftingTools = new Set<string>();
  private readonly backgroundTasks = new ClaudeTasks();
  private calls = new Map<string, TaskCall>();
  private plan: PlanItem | null = null;
  private tasks = new Map<string, { text: string; status: PlanEntry["status"] }>();
  // Consecutive API retries share one notice.
  private retryId: string | null = null;
  // A bash-mode command whose result is in a later message.
  private bash: ToolItem | null = null;

  entry<E extends Entry>(e: E): Item[] {
    if (e.type === "system") return this.system(e);
    const m = e.message as { role?: string; content?: unknown; model?: string } | undefined;
    if (!m || !e.uuid) return [];
    const uuid = e.uuid;
    if (e.type === "assistant") {
      this.retryId = null;
      if (m.model === "<synthetic>" && (e.isApiErrorMessage || e.error)) {
        const text = blocks(m.content).map((b) => (b.type === "text" ? String(b.text) : "")).join("\n").trim();
        return [{ kind: "notice", id: `${uuid}:0`, level: "error", text: text || `API error: ${String(e.error)}` }];
      }
      return this.assistant(uuid, blocks(m.content));
    }
    if (e.type !== "user" || e.isMeta || e.isCompactSummary) return [];
    return this.user(e, uuid, blocks(m.content));
  }

  private system(e: Entry): Item[] {
    const id = e.uuid ?? randomUUID();
    switch (e.subtype) {
      case "task_started":
      case "task_updated":
      case "task_progress":
      case "task_notification":
        return this.backgroundTasks.observe(e);
      case "compact_boundary": {
        const c = e.compactMetadata;
        const s = e.compact_metadata;
        return [compactNotice(id, c?.trigger ?? s?.trigger, c?.preTokens ?? s?.pre_tokens, c?.postTokens ?? s?.post_tokens)];
      }
      case "informational": {
        const text = String(e.content ?? "").trim();
        if (!text) return [];
        return [{ kind: "notice", id: e.tool_use_id ? `info:${e.tool_use_id}` : id, level: e.level === "warning" ? "warning" : "info", text }];
      }
      case "model_refusal_fallback":
      case "model_refusal_no_fallback":
        return [{ kind: "notice", id, level: "warning", text: String(e.content ?? "The model refused to answer.") }];
      case "local_command": {
        // Output of a local slash command (/context, /usage) as stored; live it
        // arrives as a synthetic assistant message with the same uuid.
        const text = String(e.content ?? "").trim();
        const out = STDOUT.exec(text);
        if (out) {
          const body = out[2]!.trim();
          if (!body) return [];
          return [out[1] === "stderr" ? { kind: "notice", id, level: "error", text: body } : { kind: "assistant", id: `${id}:0`, text: body }];
        }
        const cmd = commandText(text);
        return cmd ? [{ kind: "user", id, text: cmd }] : [];
      }
      case "api_error": {
        // Stored once per failed attempt; later attempts update the first notice.
        this.retryId ??= id;
        const attempt = e.retryAttempt && e.maxRetries ? ` (attempt ${e.retryAttempt}/${e.maxRetries})` : "";
        return [{ kind: "notice", id: this.retryId, level: "warning", text: `API error, retrying${attempt}` }];
      }
    }
    return [];
  }

  // Live api_retry messages; same notice id rules as stored api_error entries.
  retry(uuid: string, text: string): Item {
    this.retryId ??= `retry:${uuid}`;
    return { kind: "notice", id: this.retryId, level: "warning", text };
  }

  // Partial JSON is display-only text until it parses. Never invent missing
  // argument values or expose plan bookkeeping as a second raw tool card.
  stream(event: SDKPartialAssistantMessage["event"]): ToolItem[] {
    if (event.type === "message_start" || event.type === "message_stop") {
      this.inputStreams.clear();
      return [];
    }
    if (event.type === "content_block_start") {
      this.inputStreams.delete(event.index);
      const b = event.content_block;
      if (b.type !== "tool_use" || PLAN_TOOLS.has(b.name) || this.tools.has(b.id)) return [];
      const item: ToolItem = { kind: "tool", id: b.id, name: b.name, input: b.input ?? {}, status: "running" };
      this.tools.set(item.id, item);
      this.draftingTools.add(item.id);
      this.inputStreams.set(event.index, { id: item.id, json: "", truncated: false, emitted: 0 });
      return [item];
    }
    if (event.type !== "content_block_delta" && event.type !== "content_block_stop") return [];
    const s = this.inputStreams.get(event.index);
    if (!s) return [];
    const item = this.tools.get(s.id);
    if (!item || item.status !== "running" || !this.draftingTools.has(s.id)) return [];
    if (event.type === "content_block_stop") this.inputStreams.delete(event.index);
    else {
      if (event.delta.type !== "input_json_delta" || !event.delta.partial_json || s.truncated) return [];
      const remaining = MAX_TOOL_INPUT_PREVIEW - s.json.length;
      s.json += event.delta.partial_json.slice(0, remaining);
      s.truncated = event.delta.partial_json.length > remaining;
      // Bound cumulative snapshots in the manager's in-flight event buffer.
      // Show the first fragment, then every 128 characters; flush on block stop.
      if (s.emitted && s.json.length - s.emitted < 128 && !s.truncated) return [];
    }
    if (!s.json || (s.json.length === s.emitted && !s.truncated)) return [];
    let input: unknown = s.json;
    if (s.truncated) input += "\n…(input preview truncated)";
    else {
      try { input = JSON.parse(s.json); } catch { /* Incomplete JSON stays visible as text. */ }
    }
    s.emitted = s.json.length;
    const updated: ToolItem = { ...item, input };
    this.tools.set(item.id, updated);
    return [updated];
  }

  private finishInput(id: string) {
    this.draftingTools.delete(id);
    for (const [index, stream] of this.inputStreams) if (stream.id === id) this.inputStreams.delete(index);
  }

  endTurn(): ToolItem[] {
    this.retryId = null;
    const interrupted: ToolItem[] = [];
    for (const id of this.draftingTools) {
      const item = this.tools.get(id);
      if (item?.status !== "running") continue;
      const ended: ToolItem = { ...item, status: "error", output: "Tool input generation ended before execution." };
      this.tools.set(id, ended);
      interrupted.push(ended);
    }
    this.draftingTools.clear();
    this.inputStreams.clear();
    return interrupted;
  }

  private assistant(uuid: string, bs: Block[]): Item[] {
    const out: Item[] = [];
    bs.forEach((b, i) => {
      const id = `${uuid}:${i}`;
      if (b.type === "text" && String(b.text).trim()) out.push({ kind: "assistant", id, text: String(b.text) });
      else if (b.type === "thinking" && String(b.thinking ?? "").trim()) out.push({ kind: "reasoning", id, text: String(b.thinking) });
      else if (b.type === "tool_use") {
        this.finishInput(String(b.id));
        const name = String(b.name);
        const input = (b.input ?? {}) as Record<string, unknown>;
        if (PLAN_TOOLS.has(name)) {
          this.calls.set(String(b.id), { tool: name as TaskCall["tool"], input });
          // TodoWrite carries the whole list, so it applies right away.
          if (name === "TodoWrite") out.push(...this.todoWrite(String(b.id), input));
          return;
        }
        const previous = this.tools.get(String(b.id));
        const item: ToolItem = { kind: "tool", id: String(b.id), name, input: b.input, status: previous?.status ?? "running",
          ...(previous?.output !== undefined ? { output: previous.output } : {}) };
        this.tools.set(item.id, item);
        out.push(item);
      }
    });
    return out;
  }

  private user(e: Entry, uuid: string, bs: Block[]): Item[] {
    const out: Item[] = [];
    const texts: string[] = [];
    const images: ImageData[] = [];
    for (const b of bs) {
      if (b.type === "text") texts.push(String(b.text));
      else if (b.type === "image") {
        const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
        if (src?.type === "base64") images.push({ mediaType: String(src.media_type), data: src.data && src.data.length <= MAX_HISTORY_IMAGE_B64 ? src.data : undefined });
        else texts.push("[image]");
      } else if (b.type === "tool_result") out.push(...this.toolResult(b, e.toolUseResult ?? e.tool_use_result));
    }
    let text = texts.join("\n").replace(CAVEAT, "").trim();
    const stdout = STDOUT.exec(text);
    const bash = this.bashCommand(uuid, text);
    if (bash) out.unshift(bash);
    // Claude records interrupts as a synthetic user message.
    else if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) {
      out.unshift({ kind: "notice", id: uuid, text: "Interrupted" });
      if (this.bash) out.unshift({ ...this.bash, status: "error" }), (this.bash = null);
    } else if (stdout) {
      const body = stdout[2]!.trim();
      if (body) out.unshift({ kind: "notice", id: uuid, level: stdout[1] === "stderr" ? "error" : "info", text: body });
    } else {
      text = commandText(text) ?? text;
      if (text || images.length) out.unshift({ kind: "user", id: uuid, text, images: images.length ? images : undefined });
    }
    return out;
  }

  // A bash-mode command, its result, or both in one message, as one shell
  // tool item (updated in place when the result follows separately).
  private bashCommand(uuid: string, text: string): ToolItem | null {
    const input = BASH_INPUT.exec(text);
    if (input) {
      const rest = text.slice(input[0].length);
      const item: ToolItem = { kind: "tool", id: uuid, name: "shell", input: { command: input[1] }, status: "running" };
      if (!BASH_OUTPUT.test(rest)) return (this.bash = item);
      this.bash = null;
      return { ...item, ...bashResult(rest) };
    }
    if (!BASH_OUTPUT.test(text)) return null;
    const prev = this.bash ?? { kind: "tool", id: uuid, name: "shell", input: { command: "" }, status: "running" };
    this.bash = null;
    return { ...prev, ...bashResult(text) };
  }

  private toolResult(b: Block, structured: unknown): Item[] {
    const id = String(b.tool_use_id);
    this.finishInput(id);
    const call = this.calls.get(id);
    if (call && !b.is_error) {
      this.calls.delete(id);
      return call.tool === "TodoWrite" ? [] : this.taskResult(id, call, structured, toolOutput(b.content));
    }
    const prev = this.tools.get(id);
    const done: ToolItem = {
      kind: "tool",
      id,
      name: prev?.name ?? call?.tool ?? "tool",
      input: prev?.input ?? call?.input,
      status: b.is_error ? "error" : "done",
      output: toolOutput(b.content),
    };
    this.calls.delete(id);
    this.tools.set(id, done);
    return [done];
  }

  private planItem(): Item[] {
    if (!this.plan) return [];
    this.plan = { ...this.plan, entries: [...this.tasks.values()].map((t) => ({ ...t })) };
    return [this.plan];
  }

  // A list whose entries are all completed is finished; the next one is a new plan.
  private finished(): boolean {
    return [...this.tasks.values()].every((t) => t.status === "completed");
  }

  private taskResult(toolUseId: string, call: TaskCall, structured: unknown, output: string): Item[] {
    const input = call.input;
    if (call.tool === "TaskCreate") {
      const r = structured as { task?: { id?: unknown } } | undefined;
      const taskId = r?.task?.id != null ? String(r.task.id) : (/Task #(\S+) created/.exec(output)?.[1] ?? String(this.tasks.size + 1));
      if (!this.plan || this.finished()) {
        this.plan = { kind: "plan", id: `tasks:${toolUseId}`, entries: [] };
        this.tasks.clear();
      }
      this.tasks.set(taskId, { text: String(input.subject ?? input.description ?? ""), status: "pending" });
      return this.planItem();
    }
    const taskId = String(input.taskId ?? "");
    const task = this.tasks.get(taskId);
    if (!task) return [];
    if (input.status === "deleted") this.tasks.delete(taskId);
    else {
      if (typeof input.status === "string" && PLAN_STATUS.has(input.status)) task.status = input.status as PlanEntry["status"];
      if (typeof input.subject === "string" && input.subject) task.text = input.subject;
    }
    return this.planItem();
  }

  private todoWrite(toolUseId: string, input: Record<string, unknown>): Item[] {
    const todos = Array.isArray(input.todos) ? (input.todos as { content?: unknown; status?: unknown }[]) : [];
    if (!this.plan || this.finished()) this.plan = { kind: "plan", id: `todos:${toolUseId}`, entries: [] };
    this.tasks.clear();
    todos.forEach((t, i) =>
      this.tasks.set(String(i), {
        text: String(t.content ?? ""),
        status: PLAN_STATUS.has(String(t.status)) ? (t.status as PlanEntry["status"]) : "pending",
      }),
    );
    return this.planItem();
  }
}

// --- history and usage from Claude's JSONL store

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

async function transcriptPath(sessionId: string, cwd: string): Promise<string | null> {
  const projects = join(claudeDir(), "projects");
  const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // Long or unusual paths are hashed by Claude; search all project dirs.
  try {
    for (const d of await readdir(projects)) {
      const f = join(projects, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

type Line = Entry & { parentUuid?: string | null; logicalParentUuid?: string | null; isSidechain?: boolean; totalCostUSD?: number; modelUsage?: Record<string, SdkModelUsage> };

export function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Line);
    } catch {}
  }
  return out;
}

const CHAIN_TYPES = new Set(["user", "assistant", "system"]);

// The current conversation: walk parent links back from the newest entry, so
// abandoned branches are left out; compaction boundaries link to the
// pre-compaction conversation through logicalParentUuid. Parallel tool calls
// hang off side branches, so the parts of an API response on the path (same
// message.id) and the results of its tool calls are kept too. File order.
export function chain(lines: Line[]): Line[] {
  const byId = new Map<string, Line>();
  for (const l of lines) if (l.uuid) byId.set(l.uuid, l);
  const leaf = lines.findLast((l) => l.uuid && CHAIN_TYPES.has(l.type) && !l.isSidechain);
  const path = new Set<string>();
  for (let l = leaf; l && l.uuid && !path.has(l.uuid); ) {
    path.add(l.uuid);
    const parent = l.parentUuid ?? l.logicalParentUuid;
    l = parent ? byId.get(parent) : undefined;
  }
  const msgId = (l: Line) => (l.message as { id?: string } | undefined)?.id;
  const responses = new Set<string>();
  for (const l of lines) if (l.type === "assistant" && path.has(l.uuid!) && msgId(l)) responses.add(msgId(l)!);
  const keep = (l: Line) => l.type === "assistant" && (path.has(l.uuid!) || responses.has(msgId(l) ?? ""));
  const toolIds = new Set<string>();
  for (const l of lines)
    if (!l.isSidechain && keep(l)) for (const b of blocks((l.message as { content?: unknown }).content)) if (b.type === "tool_use") toolIds.add(String(b.id));
  return lines.filter((l) => {
    if (!l.uuid || !CHAIN_TYPES.has(l.type) || l.isSidechain) return false;
    if (path.has(l.uuid) || keep(l)) return true;
    return l.type === "user" && blocks((l.message as { content?: unknown } | undefined)?.content).some((b) => b.type === "tool_result" && toolIds.has(String(b.tool_use_id)));
  });
}

export function historyItems(lines: Line[]): Item[] {
  const n = new Normalizer();
  const byId = new Map<string, Item>();
  // An updated item (tool result, plan change) replaces it in place.
  for (const l of chain(lines)) for (const item of n.entry(l)) byId.set(item.id, item);
  return [...byId.values()];
}

// Context = the input side of the newest model call; totals and cost come from
// the cost-state line Claude writes after each turn.
export function usageFromLines(lines: Line[], windows?: Map<string, number>): Usage | null {
  const last = lines.findLast((l) => {
    const m = l.message as { model?: string; usage?: unknown } | undefined;
    return l.type === "assistant" && !l.isSidechain && m?.usage && m.model !== "<synthetic>";
  });
  // Claude writes cost-state when the process exits, so it can lag behind.
  const cost = lines.findLast((l) => l.type === "cost-state");
  if (!last && !cost) return null;
  const u: Usage = {};
  if (last) {
    const m = last.message as { model: string; usage: ApiUsage };
    u.model = m.model;
    u.contextTokens = contextTokens(m.usage);
    // A compaction after the last model call shrank the context.
    const boundary = lines.slice(lines.lastIndexOf(last) + 1).findLast((l) => l.subtype === "compact_boundary");
    if (boundary?.compactMetadata?.postTokens) u.contextTokens = boundary.compactMetadata.postTokens;
    const w = windows?.get(m.model);
    if (w) u.contextWindow = w;
  }
  if (cost) Object.assign(u, totals(cost.totalCostUSD, cost.modelUsage));
  return u;
}

type ApiUsage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

function contextTokens(u: ApiUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

// Input counts cached tokens too, so it is the total the model read.
function totals(costUsd: number | undefined, modelUsage: Record<string, Partial<SdkModelUsage>> | undefined): Usage {
  const ms = Object.values(modelUsage ?? {});
  if (!ms.length) return {};
  const sum = (f: (m: Partial<SdkModelUsage>) => number | undefined) => ms.reduce((a, m) => a + (f(m) ?? 0), 0);
  return {
    inputTokens: sum((m) => (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0)),
    outputTokens: sum((m) => m.outputTokens),
    costUsd: costUsd ?? sum((m) => m.costUSD),
  };
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

// Same names, order and set as Paseo.
const MODES: (ModeInfo & { id: PermissionMode })[] = [
  { id: "plan", name: "Plan mode", description: "Analyze the codebase without executing tools or edits" },
  { id: "default", name: "Always ask", description: "Prompts for permission the first time a tool is used" },
  { id: "acceptEdits", name: "Accept file edits", description: "Automatically approves edit-focused tools without prompting" },
  { id: "auto", name: "Auto mode", description: "Uses a model classifier to review permission prompts automatically" },
  { id: "bypassPermissions", name: "Bypass", description: "Skip all permission prompts (use with caution)" },
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
    modes: MODES,
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

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly (Opus)",
  seven_day_sonnet: "weekly (Sonnet)",
  overage: "extra usage",
};

class ClaudeSession implements ProviderSession {
  private input = new InputQueue();
  private q: ReturnType<typeof query>;
  private n = new Normalizer();
  private interrupted = false;
  private opts: OpenOptions;
  // Context windows by model, learned from result.modelUsage; shared per provider.
  private windows: Map<string, number>;
  private lastMessageId: string | null = null;
  private model: string | undefined;
  private compactId: string | null = null;
  private rateNotices = new Set<string>();
  private seen = new Set<string>();
  // The running user shell command, then the end of its turn: the result of
  // the transcript append (or a fallback timer if none comes).
  private shellRun: { proc: ChildProcess; interrupted: boolean } | null = null;
  private shellEnd: { outcome: "completed" | "interrupted"; timer: NodeJS.Timeout } | null = null;
  // Resumed sessions replay the stored transcript first so plan updates apply
  // to tasks created before the reload.
  private ready: Promise<void>;

  constructor(opts: OpenOptions, executable: string | undefined, windows: Map<string, number>) {
    this.opts = opts;
    this.windows = windows;
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
    this.ready = resumeId
      ? readLines(resumeId, cwd)
          .then((lines) => {
            for (const l of chain(lines)) this.n.entry(l);
          })
          .catch(() => {})
      : Promise.resolve();
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
      await this.ready;
      for await (const m of this.q) this.handle(m);
      for (const item of this.n.endTurn()) this.item(item);
      emit({ type: "closed" });
    } catch (e) {
      for (const item of this.n.endTurn()) this.item(item);
      emit({ type: "closed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private item(item: Item) {
    this.opts.emit({ type: "item", item });
  }

  private handle(m: SDKMessage) {
    const { emit } = this.opts;
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return; // subagent internals
    switch (m.type) {
      case "system":
        this.system(m);
        return;
      case "conversation_reset":
        for (const item of this.n.endTurn()) this.item(item);
        // /clear or leaving plan mode moves Claude to a new transcript.
        emit({ type: "sessionId", id: m.new_conversation_id });
        this.item({ kind: "notice", id: m.uuid, text: `Conversation reset${m.trigger ? ` (${m.trigger})` : ""}` });
        return;
      case "stream_event": {
        const ev = m.event;
        for (const item of this.n.stream(ev)) this.item(item);
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") emit({ type: "delta", kind: "assistant", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta" && ev.delta.thinking.trim())
            emit({ type: "delta", kind: "reasoning", text: ev.delta.thinking });
        }
        return;
      }
      case "assistant": {
        const msg = m.message as { id?: string; model?: string; usage?: ApiUsage };
        // Streamed messages carry one block each and repeat the call's usage.
        if (msg.usage && msg.model && msg.model !== "<synthetic>" && msg.id !== this.lastMessageId) {
          this.lastMessageId = msg.id ?? null;
          this.model = msg.model;
          const w = this.windows.get(msg.model);
          emit({ type: "usage", usage: { model: msg.model, contextTokens: contextTokens(msg.usage), ...(w ? { contextWindow: w } : {}) } });
        }
        // Claude replays a local command's output after /compact; it was shown already.
        if (this.seen.has(m.uuid)) return;
        this.seen.add(m.uuid);
        for (const item of this.n.entry(m as Entry)) this.item(item);
        return;
      }
      case "user": {
        // Our own prompts (and replayed slash commands) are emitted by the
        // manager when sent; tool results and command output are not.
        const bs = blocks(m.message.content);
        const stdout = bs.length === 1 && bs[0]!.type === "text" && STDOUT.test(String(bs[0]!.text).trim());
        if (!stdout && !bs.some((b) => b.type === "tool_result")) return;
        for (const item of this.n.entry(m as Entry)) this.item(item);
        return;
      }
      case "rate_limit_event":
        this.rateLimit(m.rate_limit_info);
        return;
      case "result": {
        if (this.shellEnd) {
          this.endShell();
          return;
        }
        const interrupted = this.interrupted;
        this.interrupted = false;
        for (const item of this.n.endTurn()) this.item(item);
        this.resultUsage(m.total_cost_usd, m.modelUsage);
        if (m.subtype === "success") emit({ type: "turnEnded", outcome: m.is_error ? "failed" : "completed", error: m.is_error ? m.result : undefined });
        else emit({ type: "turnEnded", outcome: interrupted ? "interrupted" : "failed", error: interrupted ? undefined : (m.errors ?? []).join("; ") || m.subtype });
        return;
      }
    }
  }

  private system(m: Extract<SDKMessage, { type: "system" }>) {
    switch (m.subtype) {
      case "init":
        this.opts.emit({ type: "sessionId", id: m.session_id });
        if (m.model) {
          this.model ??= m.model;
          const w = this.windows.get(m.model);
          this.opts.emit({ type: "usage", usage: { model: m.model, ...(w ? { contextWindow: w } : {}) } });
        }
        return;
      case "api_retry": {
        const cause = m.error_status ? `${m.error} (HTTP ${m.error_status})` : m.error === "unknown" ? "connection error" : m.error;
        const secs = Math.max(1, Math.round(m.retry_delay_ms / 1000));
        this.item(this.n.retry(m.uuid, `API ${cause}, retrying in ${secs}s (attempt ${m.attempt}/${m.max_retries})`));
        return;
      }
      case "status":
        if (m.status === "compacting") {
          this.compactId = `compact:${m.uuid}`;
          this.item({ kind: "notice", id: this.compactId, level: "info", text: "Compacting conversation…" });
        } else if (m.compact_result === "failed") {
          this.item({ kind: "notice", id: this.compactId ?? m.uuid, level: "error", text: `Compaction failed${m.compact_error ? `: ${m.compact_error}` : ""}` });
          this.compactId = null;
        }
        return;
      case "compact_boundary": {
        const c = m.compact_metadata;
        this.item(compactNotice(this.compactId ?? m.uuid, c.trigger, c.pre_tokens, c.post_tokens));
        this.compactId = null;
        if (c.post_tokens) this.opts.emit({ type: "usage", usage: { contextTokens: c.post_tokens } });
        return;
      }
      case "informational":
      case "model_refusal_fallback":
      case "model_refusal_no_fallback":
      case "task_started":
      case "task_updated":
      case "task_progress":
      case "task_notification":
        for (const item of this.n.entry(m as Entry)) this.item(item);
        return;
      case "local_command_output":
        if (m.content.trim()) this.item({ kind: "assistant", id: m.uuid, text: m.content });
        return;
      case "permission_denied":
        this.item({
          kind: "notice",
          id: `denied:${m.tool_use_id}`,
          level: "warning",
          text: `${m.tool_name} was denied${m.decision_reason ? `: ${m.decision_reason}` : ""}`,
        });
        return;
      case "notification":
        this.item({ kind: "notice", id: `notification:${m.key}`, level: m.priority === "high" || m.priority === "immediate" ? "warning" : "info", text: m.text });
        return;
    }
  }

  private rateLimit(info: SDKRateLimitInfo) {
    const kind = (info.rateLimitType ?? "usage").replace(/_/g, "-");
    this.opts.emit({
      type: "limits",
      limits: {
        windows: [
          {
            id: info.rateLimitType ?? "usage",
            label: LIMIT_LABELS[info.rateLimitType ?? ""] ?? kind,
            usedPercent: info.utilization != null ? Math.round(info.utilization * 1000) / 10 : undefined,
            resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : undefined,
            status: info.status === "rejected" ? "exhausted" : info.status === "allowed_warning" ? "warning" : "ok",
          },
        ],
      },
    });
    const resets = info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : "";
    if (info.status === "rejected") {
      this.item({ kind: "notice", id: `ratelimit:${kind}`, level: "error", text: `Rate limit reached (${kind} limit)${resets}` });
    } else if (info.status === "allowed_warning" && info.utilization != null) {
      // Once per threshold, not on every turn.
      const key = `${kind}:${info.surpassedThreshold ?? ""}`;
      if (this.rateNotices.has(key)) return;
      this.rateNotices.add(key);
      this.item({ kind: "notice", id: `ratelimit:${kind}`, level: "warning", text: `${Math.round(info.utilization * 100)}% of the ${kind} limit used${resets}` });
    }
  }

  private resultUsage(costUsd: number, modelUsage: Record<string, SdkModelUsage>) {
    // Local-command-only turns report zeroed, empty usage.
    if (!Object.keys(modelUsage ?? {}).length) return;
    for (const [model, u] of Object.entries(modelUsage)) if (u.contextWindow) this.windows.set(model, u.contextWindow);
    const w = this.model ? this.windows.get(this.model) : undefined;
    this.opts.emit({ type: "usage", usage: { ...totals(costUsd, modelUsage), ...(w ? { contextWindow: w } : {}) } });
  }

  send(text: string, itemId: string, images?: ImageData[]) {
    this.input.push({
      type: "user",
      message: { role: "user", content: promptContent(text, images) },
      parent_tool_use_id: null,
      uuid: itemId as SDKUserMessage["uuid"],
    });
  }

  // Bash mode, as Claude's own `!cmd` does it: the command runs in the
  // session's cwd and env, and the command with its output is appended to the
  // transcript without a model turn (shouldQuery: false), so the model sees it
  // with the next prompt. The append reports a zero-turn result, which ends
  // the turn. The record's uuid is the item id, so history matches.
  shell(command: string, itemId: string) {
    const { cwd, config, emit } = this.opts;
    const item: ToolItem = { kind: "tool", id: itemId, name: "shell", input: { command }, status: "running" };
    this.item(item);
    const env = { ...(process.env as Record<string, string>), ...config.env };
    const proc = spawn(shellPath(env.SHELL), ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const run = { proc, interrupted: false };
    this.shellRun = run;
    let stdout = "";
    let stderr = "";
    let all = "";
    const out = (to: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (to === "stdout") stdout += text;
      else stderr += text;
      all += text;
      emit({ type: "toolOutput", itemId, text });
    };
    proc.stdout!.on("data", out("stdout"));
    proc.stderr!.on("data", out("stderr"));
    let done = false;
    const finish = (exitCode: number, error?: string) => {
      if (done) return;
      done = true;
      this.shellRun = null;
      if (error) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${error}`;
      const output = toolOutput([all.trimEnd(), error].filter(Boolean).join("\n"));
      this.item({ ...item, status: exitCode === 0 ? "done" : "error", output });
      this.shellEnd = {
        outcome: run.interrupted ? "interrupted" : "completed",
        timer: setTimeout(() => this.endShell(), 15_000),
      };
      this.input.push({
        type: "user",
        message: { role: "user", content: bashRecord(command, stdout, stderr, exitCode) },
        parent_tool_use_id: null,
        shouldQuery: false,
        uuid: itemId as SDKUserMessage["uuid"],
      });
    };
    proc.on("error", (e) => finish(127, e.message));
    proc.on("close", (code, signal) => finish(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0)));
  }

  private endShell() {
    if (!this.shellEnd) return;
    clearTimeout(this.shellEnd.timer);
    const { outcome } = this.shellEnd;
    this.shellEnd = null;
    this.interrupted = false;
    this.opts.emit({ type: "turnEnded", outcome });
  }

  async interrupt() {
    const run = this.shellRun;
    if (run) {
      // The whole process group: the shell and what it started.
      run.interrupted = true;
      killGroup(run.proc, "SIGTERM");
      setTimeout(() => this.shellRun === run && killGroup(run.proc, "SIGKILL"), 2000).unref();
      return;
    }
    if (this.shellEnd) return;
    this.interrupted = true;
    await this.q.interrupt();
  }

  async close() {
    if (this.shellRun) killGroup(this.shellRun.proc, "SIGKILL");
    this.input.end();
    this.q.close();
  }
}

// The user's shell when it takes `-c` like sh, else bash.
function shellPath(shell: string | undefined): string {
  return shell && /\/(?:ba|z|k|da)?sh$/.test(shell) ? shell : "/bin/bash";
}

function killGroup(proc: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (proc.pid) process.kill(-proc.pid, signal);
  } catch {
    // Already gone.
  }
}

// Images go first, as the API recommends; slash commands stay plain text.
export function promptContent(text: string, images?: ImageData[]): SDKUserMessage["message"]["content"] {
  if (!images?.length) return text;
  const content: Block[] = images
    .filter((i) => i.data)
    .map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }));
  if (text) content.push({ type: "text", text });
  return content as unknown as SDKUserMessage["message"]["content"];
}

async function readLines(sessionId: string, cwd: string): Promise<Line[]> {
  const path = await transcriptPath(sessionId, cwd);
  return path ? parseLines(await readFile(path, "utf8")) : [];
}

// A short-lived query whose input never yields: it initializes, answers
// control requests and is closed without starting a session.
async function withIdleQuery<T>(executable: string | undefined, cwd: string, what: string, f: (q: ReturnType<typeof query>) => Promise<T>): Promise<T> {
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
  };
  const q = query({ prompt: idle, options: { cwd, pathToClaudeCodeExecutable: executable, env: process.env as Record<string, string> } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude did not report its ${what} in time`)), CATALOG_TIMEOUT_MS);
    });
    return await Promise.race([f(q), timeout]);
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

function fetchCatalog(executable: string | undefined): Promise<Catalog> {
  return withIdleQuery(executable, homedir(), "models", async (q) => parseCatalog(await q.supportedModels()));
}

// supportedCommands() has no kind; names reloadSkills() returns are skills.
export function parseCommands(commands: SlashCommand[], skills: SlashCommand[]): Command[] {
  const skillNames = new Set(skills.map((s) => s.name));
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const c of commands) {
    // Internal commands ("__remote-workflow") and duplicate rows are not typed by users.
    if (c.name.startsWith("__") || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description || undefined,
      argumentHint: c.argumentHint || undefined,
      kind: skillNames.has(c.name) ? "skill" : "command",
    });
  }
  return out;
}

function fetchCommands(executable: string | undefined, cwd: string): Promise<Command[]> {
  return withIdleQuery(executable, cwd, "commands", async (q) => {
    const commands = await q.supportedCommands();
    const skills = await q.reloadSkills().then((r) => r.skills, () => []);
    return parseCommands(commands, skills);
  });
}

export function claudeProvider(): Provider {
  const executable = findClaude();
  const windows = new Map<string, number>();
  return {
    id: "claude",
    open: (opts) => new ClaudeSession(opts, executable, windows),
    catalog: () => fetchCatalog(executable),
    commands: (cwd) => fetchCommands(executable, cwd),
    async history(sessionId, cwd) {
      return historyItems(await readLines(sessionId, cwd));
    },
    async usage(sessionId, cwd) {
      return usageFromLines(await readLines(sessionId, cwd), windows);
    },
    memories: claudeMemories,
  };
}

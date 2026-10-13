// pi via `pi --mode rpc`: one process per open session, JSONL commands on
// stdin, responses and session events on stdout. The native session id is the
// session file path (what `--session` resumes); history reads that file.
//
// pi has no permission system of its own. Extensions can ask through dialogs
// (extension_ui_request); `confirm` and two-option `select` are routed through
// askPermission, other dialogs are cancelled.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Item } from "@casm/protocol";
import type { OpenOptions, Provider, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;

// --- normalization (shared by history and live events)

type Block = { type: string; [k: string]: unknown };
type Tool = Extract<Item, { kind: "tool" }>;

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
  summary?: string;
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

// Turns one pi message into items. Assistant blocks are keyed by the message
// timestamp, which is the same live and on disk. `tools` carries tool calls so
// a later toolResult can complete them; completed tools are returned again so
// callers can upsert. `fallbackId` names messages without a timestamp.
export function normalize(msg: PiMessage, tools: Map<string, Tool>, fallbackId = ""): Item[] {
  const key = msg.timestamp !== undefined ? String(msg.timestamp) : fallbackId;
  const out: Item[] = [];
  switch (msg.role) {
    case "user": {
      const t = text(msg.content).trim();
      if (t) out.push({ kind: "user", id: fallbackId || key, text: t });
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
      if (msg.stopReason === "error" && msg.errorMessage) out.push({ kind: "notice", id: `${key}:error`, text: msg.errorMessage });
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
      };
      tools.set(id, done);
      out.push(done);
      break;
    }
    case "bashExecution":
      out.push({
        kind: "tool",
        id: key,
        name: "bash",
        input: { command: msg.command },
        status: msg.exitCode === 0 ? "done" : "error",
        output: truncate(msg.output ?? ""),
      });
      break;
    case "custom":
      if (msg.display) {
        const t = text(msg.content).trim();
        if (t) out.push({ kind: "notice", id: key, text: t });
      }
      break;
  }
  return out;
}

type Entry = { type: string; id?: string; parentId?: string | null; message?: PiMessage; summary?: string };

// Normalizes a session file along the active branch (last entry back to the root).
export function parseSession(jsonl: string): Item[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e.id) entries.push(e);
    } catch {}
  }
  const byId = new Map(entries.map((e) => [e.id!, e]));
  const path: Entry[] = [];
  for (let e = entries.at(-1); e; e = e.parentId ? byId.get(e.parentId) : undefined) path.unshift(e);

  const tools = new Map<string, Tool>();
  const items = new Map<string, Item>();
  for (const e of path) {
    if (e.type === "message" && e.message) {
      // A tool result replaces its call in place.
      for (const item of normalize(e.message, tools, e.id)) items.set(item.id, item);
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      items.set(e.id!, { kind: "notice", id: e.id!, text: `${e.type === "compaction" ? "Context compacted" : "Branch summary"}: ${e.summary ?? ""}`.trim() });
    }
  }
  return [...items.values()];
}

// --- RPC process

type Rec = { type: string; id?: string; [k: string]: unknown };

class PiSession implements ProviderSession {
  private proc: ChildProcessWithoutNullStreams;
  private opts: OpenOptions;
  private tools = new Map<string, Tool>();
  private pending = new Map<string, (r: Rec) => void>();
  private seq = 0;
  private buf = "";
  private stderr = "";
  private running = false;
  private interrupted = false;
  private lastError: string | undefined;
  private turnAbort = new AbortController();
  private dead = false;

  constructor(opts: OpenOptions) {
    this.opts = opts;
    const { cwd, config, resumeId } = opts;
    const args = ["--mode", "rpc"];
    if (resumeId) args.push("--session", resumeId);
    if (config.model) args.push("--model", config.model);
    if (config.effort) args.push("--thinking", config.effort);
    if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);
    if (process.env.CASM_PI_ARGS) args.push(...process.env.CASM_PI_ARGS.split(" ").filter(Boolean));
    this.proc = spawn(process.env.CASM_PI_PATH ?? "pi", args, { cwd, env: { ...process.env, ...config.env } });
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
      const data = r.data as { sessionFile?: string } | undefined;
      if (r.success && data?.sessionFile) opts.emit({ type: "sessionId", id: data.sessionFile });
    });
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

  private request(cmd: Rec): Promise<Rec> {
    const id = `casm-${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ ...cmd, id });
    });
  }

  private handle(r: Rec) {
    const { emit } = this.opts;
    switch (r.type) {
      case "response": {
        const resolve = r.id ? this.pending.get(r.id) : undefined;
        if (resolve) {
          this.pending.delete(r.id!);
          resolve(r);
        }
        return;
      }
      case "message_update": {
        const ev = r.assistantMessageEvent as { type: string; delta?: string };
        if (ev.type === "text_delta") emit({ type: "delta", kind: "assistant", text: ev.delta ?? "" });
        else if (ev.type === "thinking_delta") emit({ type: "delta", kind: "reasoning", text: ev.delta ?? "" });
        return;
      }
      case "message_end": {
        const m = r.message as PiMessage;
        // Our own prompts (and steers) are emitted by the manager when sent.
        if (m.role === "user") return;
        if (m.role === "assistant") this.lastError = m.stopReason === "error" ? m.errorMessage || "pi reported an error" : undefined;
        for (const item of normalize(m, this.tools)) emit({ type: "item", item });
        return;
      }
      case "agent_settled":
        this.endTurn(r.aborted === true || this.interrupted ? "interrupted" : this.lastError ? "failed" : "completed", this.lastError);
        return;
      case "extension_ui_request":
        void this.dialog(r);
        return;
    }
  }

  private endTurn(outcome: "completed" | "interrupted" | "failed", error?: string) {
    if (!this.running) return;
    this.running = false;
    this.interrupted = false;
    this.lastError = undefined;
    this.turnAbort.abort();
    this.opts.emit({ type: "turnEnded", outcome, error: outcome === "failed" ? error : undefined });
  }

  private async dialog(r: Rec) {
    const method = r.method as string;
    const options = Array.isArray(r.options) ? (r.options as string[]) : [];
    const id = String(r.id);
    if (method !== "confirm" && !(method === "select" && options.length === 2)) {
      if (method === "select" || method === "input" || method === "editor") this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const title = [r.title, r.message].filter((s) => typeof s === "string" && s).join("\n\n");
    try {
      const answer = await this.opts.askPermission(
        { id, toolName: `pi ${method}`, input: { title: r.title, message: r.message, options }, title, canAlwaysAllow: false },
        this.turnAbort.signal,
      );
      const allow = answer.decision !== "deny";
      if (method === "confirm") this.write({ type: "extension_ui_response", id, confirmed: allow });
      else this.write({ type: "extension_ui_response", id, value: options[allow ? 0 : 1] });
    } catch {
      this.write({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  send(text: string, _itemId: string) {
    if (this.running) {
      void this.request({ type: "steer", message: text });
      return;
    }
    this.running = true;
    this.turnAbort = new AbortController();
    void this.request({ type: "prompt", message: text }).then((r) => {
      const disposition = (r.data as { disposition?: string } | undefined)?.disposition;
      if (!r.success) this.endTurn("failed", String(r.error ?? "prompt rejected"));
      else if (disposition === "handled") this.endTurn("completed");
    });
  }

  async interrupt() {
    if (!this.running) return;
    this.interrupted = true;
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
  };
}

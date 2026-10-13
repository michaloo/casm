// Claude Code via the Claude Agent SDK: one long-lived query() per open
// session, fed by an async input queue. History comes from Claude's own JSONL.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  query,
  getSessionMessages,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Item } from "@casm/protocol";
import type { OpenOptions, Provider, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;

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
    if (text) out.unshift({ kind: "user", id: msg.uuid, text });
  }
  return out;
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
      model: config.model,
      permissionMode: config.mode as PermissionMode | undefined,
      effort: config.effort as Options["effort"],
      systemPrompt: { type: "preset", preset: "claude_code", append: config.systemPrompt },
      mcpServers: config.mcpServers as Options["mcpServers"],
      env: { ...(process.env as Record<string, string>), ...config.env },
      includePartialMessages: true,
      pathToClaudeCodeExecutable: executable,
      canUseTool: this.canUseTool,
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  private canUseTool: CanUseTool = async (toolName, input, o) => {
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
      case "stream_event": {
        const ev = m.event;
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") emit({ type: "delta", kind: "assistant", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") emit({ type: "delta", kind: "reasoning", text: ev.delta.thinking });
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

export function claudeProvider(): Provider {
  const executable = findClaude();
  return {
    id: "claude",
    open: (opts) => new ClaudeSession(opts, executable),
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

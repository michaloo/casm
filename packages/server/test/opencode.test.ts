import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imageParts,
  normalizeMessages,
  normalizePart,
  outputDelta,
  parseCatalog,
  parseCommands,
  parseSlash,
  planEntries,
  sessionUsage,
  SHELL_MARKER,
  shellTool,
  questionReply,
  questionRequest,
  type OcAgent,
  type OcMessage,
  type OcPart,
  type OcProviders,
  type OcQuestion,
} from "../src/providers/opencode.ts";

const ids = { sessionID: "ses_1", messageID: "msg_a1" };

// Shapes as returned by `GET /session/:id/message` (opencode 1.19), trimmed.
const messages: OcMessage[] = [
  {
    info: { id: "msg_u1", sessionID: "ses_1", role: "user" },
    parts: [
      { id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "Read /etc/hostname" },
      { id: "prt_u2", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "<file attachment>", synthetic: true },
    ],
  },
  {
    info: { id: "msg_a1", sessionID: "ses_1", role: "assistant" },
    parts: [
      { id: "prt_s1", ...ids, type: "step-start" },
      { id: "prt_r1", ...ids, type: "reasoning", text: "I'll use the read tool.", time: { start: 1, end: 2 } },
      {
        id: "prt_t1",
        ...ids,
        type: "tool",
        tool: "read",
        callID: "call-1",
        state: { status: "completed", input: { filePath: "/etc/hostname" }, output: "1: box\n" },
      },
      {
        id: "prt_t2",
        ...ids,
        type: "tool",
        tool: "read",
        callID: "call-2",
        state: { status: "error", input: { filePath: "/etc/os-release" }, error: "The user rejected permission to use this specific tool call." },
      },
      { id: "prt_x1", ...ids, type: "text", text: "It says box.", time: { start: 3, end: 4 } },
      { id: "prt_f1", ...ids, type: "step-finish" },
    ],
  },
  {
    info: { id: "msg_a2", sessionID: "ses_1", role: "assistant", error: { name: "APIError", data: { message: "rate limited" } } },
    parts: [],
  },
  {
    info: { id: "msg_a3", sessionID: "ses_1", role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    parts: [],
  },
];

test("normalizes a session transcript", () => {
  assert.deepEqual(normalizeMessages(messages), [
    { kind: "user", id: "msg_u1", text: "Read /etc/hostname" },
    { kind: "reasoning", id: "prt_r1", text: "I'll use the read tool." },
    { kind: "tool", id: "prt_t1", name: "read", input: { filePath: "/etc/hostname" }, status: "done", output: "1: box\n" },
    {
      kind: "tool",
      id: "prt_t2",
      name: "read",
      input: { filePath: "/etc/os-release" },
      status: "error",
      output: "The user rejected permission to use this specific tool call.",
    },
    { kind: "assistant", id: "prt_x1", text: "It says box." },
    { kind: "notice", id: "msg_a2:error", text: "rate limited", level: "error" },
  ]);
});

test("live tool parts map to running, then done with truncated output", () => {
  const part: OcPart = {
    id: "prt_t9",
    ...ids,
    type: "tool",
    tool: "bash",
    callID: "call-9",
    state: { status: "running", input: { command: "ls" } },
  };
  assert.deepEqual(normalizePart(part), { kind: "tool", id: "prt_t9", name: "bash", input: { command: "ls" }, status: "running" });
  const done = normalizePart({ ...part, state: { status: "completed", input: { command: "ls" }, output: "x".repeat(9000) } });
  assert.ok(done?.kind === "tool" && done.status === "done");
  assert.ok(done.output!.length < 8100 && done.output!.endsWith("(truncated)"));
});

test("empty text and bookkeeping parts produce nothing", () => {
  assert.equal(normalizePart({ id: "prt_r", ...ids, type: "reasoning", text: "", time: { start: 1 } }), null);
  assert.equal(normalizePart({ id: "prt_s", ...ids, type: "step-finish" }), null);
});

// `question.asked` properties (opencode 1.19), second question added for multi/text cases.
const question: OcQuestion = {
  id: "que_134adfbd4001HBnsd3INhR0yFf",
  sessionID: "ses_1",
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [
        { label: "Red", description: "The color red" },
        { label: "Green", description: "" },
      ],
    },
    { question: "Which files?", header: "Files", options: [{ label: "a.ts", description: "" }, { label: "b.ts", description: "" }], multiple: true, custom: false },
    { question: "Anything else?", header: "", options: [] },
  ],
};

test("maps a native question to a QuestionRequest", () => {
  assert.deepEqual(questionRequest(question), {
    id: "que_134adfbd4001HBnsd3INhR0yFf",
    prompts: [
      {
        id: "q0",
        text: "Which color do you prefer?",
        header: "Color",
        kind: "select",
        options: [{ label: "Red", description: "The color red" }, { label: "Green" }],
        multiple: false,
        allowOther: true,
      },
      {
        id: "q1",
        text: "Which files?",
        header: "Files",
        kind: "select",
        options: [{ label: "a.ts" }, { label: "b.ts" }],
        multiple: true,
        allowOther: false,
      },
      { id: "q2", text: "Anything else?", header: undefined, kind: "text" },
    ],
  });
});

test("maps answers to one label list per question, in order", () => {
  assert.deepEqual(questionReply(question, { q0: "Green", q1: ["a.ts", "b.ts"], q2: "  no  " }), [["Green"], ["a.ts", "b.ts"], ["no"]]);
  assert.deepEqual(questionReply(question, { q0: "Purple" }), [["Purple"], [], []]);
  assert.deepEqual(questionReply(question, { q0: true, q2: "" }), [["Yes"], [], []]);
});

// Trimmed `GET /config/providers` and `GET /agent` output.
const providers: OcProviders = {
  providers: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "big-pickle": { id: "big-pickle", name: "Big Pickle", status: "active", variants: {} },
        "cat-jam-free": { id: "cat-jam-free", name: "Cat Jam Free", status: "active", variants: { low: {}, high: {} } },
        "old-free": { id: "old-free", name: "Old", status: "deprecated" },
      },
    },
    { id: "llama.cpp", name: "llama-server (router)", models: { "qwen3.6-35b": { id: "qwen3.6-35b", name: "qwen3.6-35b" } } },
  ],
  default: { opencode: "big-pickle", "llama.cpp": "qwen3.6-35b" },
};

const agents: OcAgent[] = [
  { name: "build", mode: "primary", description: "The default agent." },
  { name: "compaction", mode: "primary", hidden: true },
  { name: "explore", mode: "subagent", description: "Fast agent." },
  { name: "plan", mode: "primary", description: "Plan mode." },
  { name: "review", mode: "all" },
];

test("parses the catalog: provider/model ids, variants as efforts, primary agents as modes", () => {
  assert.deepEqual(parseCatalog(providers, agents, undefined), {
    models: [
      { id: "opencode/big-pickle", name: "Big Pickle", description: "OpenCode", isDefault: true },
      { id: "opencode/cat-jam-free", name: "Cat Jam Free", description: "OpenCode", efforts: ["low", "high"] },
      { id: "llama.cpp/qwen3.6-35b", name: "qwen3.6-35b", description: "llama-server (router)" },
    ],
    modes: [
      { id: "build", description: "The default agent." },
      { id: "plan", description: "Plan mode." },
      { id: "review" },
    ],
  });
  const fromConfig = parseCatalog(providers, agents, "llama.cpp/qwen3.6-35b");
  assert.deepEqual(fromConfig.models.filter((m) => m.isDefault).map((m) => m.id), ["llama.cpp/qwen3.6-35b"]);
});

// --- chat features (shapes from opencode 1.19 live sessions, trimmed)

const sid = "ses_2";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJ";
const todos = (a: string, b: string) => [
  { content: "a", status: a, priority: "medium" },
  { content: "b", status: b, priority: "medium" },
];
const todowrite = (id: string, messageID: string, list: ReturnType<typeof todos>): OcPart => ({
  id,
  sessionID: sid,
  messageID,
  type: "tool",
  tool: "todowrite",
  callID: id,
  state: { status: "completed", input: { todos: list }, output: JSON.stringify(list), metadata: { todos: list } },
});
const tokens = (input: number, read: number, output: number) => ({ total: input + read + output, input, output, reasoning: 1, cache: { read, write: 0 } });

const chat: OcMessage[] = [
  {
    info: { id: "msg_u1", sessionID: sid, role: "user" },
    parts: [
      { id: "prt_1", sessionID: sid, messageID: "msg_u1", type: "text", text: "What colour is this image? One word." },
      { id: "prt_2", sessionID: sid, messageID: "msg_u1", type: "file", mime: "image/png", filename: "red.png", url: `data:image/png;base64,${PNG}` },
      { id: "prt_3", sessionID: sid, messageID: "msg_u1", type: "file", mime: "text/plain", filename: "a.txt", url: "file:///tmp/a.txt" },
    ],
  },
  {
    info: { id: "msg_a1", sessionID: sid, role: "assistant", parentID: "msg_u1", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0.01, tokens: tokens(5616, 7808, 3) },
    parts: [
      { id: "prt_4", sessionID: sid, messageID: "msg_a1", type: "retry", attempt: 1, error: { name: "APIError", data: { message: "Rate limited" } } },
      todowrite("prt_5", "msg_a1", todos("in_progress", "pending")),
      { id: "prt_6", sessionID: sid, messageID: "msg_a1", type: "step-finish" },
    ],
  },
  {
    info: { id: "msg_a2", sessionID: sid, role: "assistant", parentID: "msg_u1", providerID: "opencode", modelID: "mimo-v2.6-flash-free", cost: 0.02, tokens: tokens(62, 13760, 74) },
    parts: [
      todowrite("prt_7", "msg_a2", todos("completed", "cancelled")),
      { id: "prt_8", sessionID: sid, messageID: "msg_a2", type: "text", text: "Red", time: { start: 1, end: 2 } },
    ],
  },
  {
    info: { id: "msg_u2", sessionID: sid, role: "user" },
    parts: [{ id: "prt_9", sessionID: sid, messageID: "msg_u2", type: "compaction", auto: true }],
  },
];

test("history: images, retry and compaction notices, one plan per turn", () => {
  assert.deepEqual(normalizeMessages(chat), [
    { kind: "user", id: "msg_u1", text: "What colour is this image? One word.", images: [{ mediaType: "image/png", data: PNG }] },
    { kind: "notice", id: "msg_u1:retry", text: "Retry attempt 1: Rate limited", level: "warning" },
    {
      kind: "plan",
      id: "msg_u1:plan",
      entries: [
        { text: "a", status: "completed" },
        { text: "b (cancelled)", status: "completed" },
      ],
    },
    { kind: "assistant", id: "prt_8", text: "Red" },
    { kind: "notice", id: "prt_9", text: "Context compacted (auto)", level: "info" },
  ]);
});

test("history drops image data over ~1 MB and keeps image-only prompts", () => {
  const big = "A".repeat(1_500_000);
  const items = normalizeMessages([
    { info: { id: "msg_u", sessionID: sid, role: "user" }, parts: [{ id: "p", sessionID: sid, messageID: "msg_u", type: "file", mime: "image/jpeg", url: `data:image/jpeg;base64,${big}` }] },
  ]);
  assert.deepEqual(items, [{ kind: "user", id: "msg_u", text: "", images: [{ mediaType: "image/jpeg" }] }]);
});

test("images become data-URL file parts", () => {
  assert.deepEqual(imageParts([{ mediaType: "image/png", data: PNG }, { mediaType: "image/jpeg" }]), [
    { type: "file", mime: "image/png", filename: "image-1.png", url: `data:image/png;base64,${PNG}` },
  ]);
});

test("plan entries map todo statuses", () => {
  assert.deepEqual(planEntries(todos("pending", "in_progress")), [
    { text: "a", status: "pending" },
    { text: "b", status: "in_progress" },
  ]);
});

test("usage: context of the latest step, totals over the session", () => {
  const usage = sessionUsage(
    chat.map((m) => m.info),
    (m) => (m === "opencode/mimo-v2.6-flash-free" ? 200000 : undefined),
  );
  assert.equal(usage?.model, "opencode/mimo-v2.6-flash-free");
  assert.equal(usage?.contextTokens, 62 + 13760);
  assert.equal(usage?.contextWindow, 200000);
  assert.equal(usage?.inputTokens, 5616 + 7808 + 62 + 13760);
  assert.equal(usage?.outputTokens, 3 + 1 + 74 + 1);
  assert.ok(Math.abs(usage!.costUsd! - 0.03) < 1e-9);
  assert.equal(sessionUsage([{ id: "msg_x", sessionID: sid, role: "assistant", tokens: tokens(0, 0, 0) }]), null);
});

test("streamed tool output deltas", () => {
  assert.equal(outputDelta("", "1\n"), "1\n");
  assert.equal(outputDelta("1\n", "1\n2\n"), "2\n");
  // The snapshot keeps only the tail once output grows large.
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join("");
  assert.equal(outputDelta(lines(1, 100), lines(50, 101)), "line 101\n");
});

test("commands and skills from GET /command; slash parsing", () => {
  assert.deepEqual(
    parseCommands([
      { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted", source: "command", hints: ["$ARGUMENTS"] },
      { name: "pick", source: "command", hints: ["$1", "$2"] },
      { name: "pdf", description: "Use this skill for PDFs", source: "skill", hints: [] },
    ]),
    [
      { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted", argumentHint: "[arguments]", kind: "command" },
      { name: "pick", argumentHint: "<arg1> <arg2>", kind: "command" },
      { name: "pdf", description: "Use this skill for PDFs", kind: "skill" },
    ],
  );
  assert.deepEqual(parseSlash("/sayback banana split"), { name: "sayback", args: "banana split" });
  assert.deepEqual(parseSlash("/init"), { name: "init", args: "" });
  assert.equal(parseSlash("hello /x"), null);
});

test("a todowrite part maps to the turn's plan", () => {
  assert.deepEqual(normalizePart(todowrite("prt_t", "msg_a", todos("pending", "pending")), "msg_u"), {
    kind: "plan",
    id: "msg_u:plan",
    entries: [
      { text: "a", status: "pending" },
      { text: "b", status: "pending" },
    ],
  });
});

test("shell commands: the bash part after the synthetic user message is a shell item; aborts are errors", () => {
  const sh = { sessionID: "ses_1", messageID: "msg_sa" };
  const shellMessages: OcMessage[] = [
    { info: { id: "msg_su", sessionID: "ses_1", role: "user" }, parts: [{ id: "prt_su", sessionID: "ses_1", messageID: "msg_su", type: "text", text: SHELL_MARKER, synthetic: true }] },
    {
      info: { id: "msg_sa", sessionID: "ses_1", role: "assistant", parentID: "msg_su" },
      parts: [{ id: "prt_sh", ...sh, type: "tool", tool: "bash", callID: "c", state: { status: "completed", input: { command: "sleep 30" }, output: "start\n\n\n<metadata>\nUser aborted the command\n</metadata>" } }],
    },
  ];
  assert.deepEqual(normalizeMessages(shellMessages), [{ kind: "tool", id: "prt_sh", name: "shell", origin: "user", input: { command: "sleep 30" }, status: "error", output: "start" }]);
  const ok = shellTool({ kind: "tool", id: "p", name: "bash", input: { command: "ls" }, status: "done", output: "a\n" });
  assert.deepEqual(ok, { kind: "tool", id: "p", name: "shell", origin: "user", input: { command: "ls" }, status: "done", output: "a\n" });
  // A model's bash call stays bash.
  assert.equal((normalizeMessages(messages.slice(0, 2))[2] as { name: string }).name, "read");
});

// Exercise the real SSE dispatcher/session adapter with native wire shapes.
import { OpencodeServer, opencodeProvider } from "../src/providers/opencode.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const taskPart = (status: "pending" | "running" | "completed" | "error"): OcPart => ({
  id: "prt_task", ...ids, type: "tool", tool: "task",
  state: { status, input: { description: "Inspect files", subagent_type: "explore" }, metadata: { sessionId: "ses_child" }, output: "Found files", error: "Task failed" },
});

class FakeOpencodeServer extends OpencodeServer {
  parentMessages: OcMessage[] = [{ info: { id: ids.messageID, sessionID: ids.sessionID, role: "assistant" }, parts: [taskPart("completed")] }];
  childMessages: OcMessage[] = [{ info: { id: "child_a", sessionID: "ses_child", role: "assistant" }, parts: [{ id: "child_text", sessionID: "ses_child", messageID: "child_a", type: "text", text: "Private child result" }] }];
  parentID = ids.sessionID;
  releases = 0;
  override async acquire() { return () => { this.releases++; }; }
  override async contextWindows() { return new Map<string, number>(); }
  override async request<T>(_method: string, path: string): Promise<T> {
    if (path === "/session") return { id: ids.sessionID } as T;
    if (path === `/session/${ids.sessionID}/message`) return this.parentMessages as T;
    if (path === "/session/ses_child/message") return this.childMessages as T;
    if (path === "/session/ses_child") return { parentID: this.parentID } as T;
    throw new Error(`Unexpected request: ${path}`);
  }
  event(type: string, properties: Record<string, unknown>) { this.dispatch(JSON.stringify({ payload: { type, properties } })); }
}

test("task states normalize to stable subagent ids, including failures and missing metadata", () => {
  for (const status of ["pending", "running", "completed", "error"] as const) {
    const item = normalizePart(taskPart(status));
    assert.ok(item?.kind === "subagent");
    assert.equal(item.id, "prt_task");
    assert.equal(item.title, "Inspect files");
    assert.equal(item.agentType, "explore");
    assert.equal(item.status, status === "completed" ? "done" : status === "error" ? "error" : "running");
    assert.equal(item.summary, status === "completed" ? "Found files" : status === "error" ? "Task failed" : undefined);
  }
  assert.deepEqual(normalizePart({ ...taskPart("pending"), state: { status: "pending" } }), { kind: "subagent", id: "prt_task", title: "Task", status: "running" });
});

test("child SSE updates only task activity; live and history ids agree", async () => {
  const server = new FakeOpencodeServer();
  const provider = opencodeProvider(server);
  const events: ProviderEvent[] = [];
  const session = provider.open({ cwd: "/tmp", config: {}, resumeId: null, emit: (e) => events.push(e), askPermission: async () => ({ decision: "allow" }), askQuestion: async () => null });
  await new Promise((r) => setImmediate(r));
  server.dispatch(JSON.stringify({ payload: { type: "server.connected" } }));
  server.dispatch("invalid json");
  server.event("message.updated", { info: { id: ids.messageID, sessionID: ids.sessionID, role: "assistant" } });
  server.event("session.created", { info: { id: "ses_child", parentID: ids.sessionID } });
  // A child tool can arrive before the parent task's metadata update.
  server.event("message.part.updated", { part: { id: "child_tool", sessionID: "ses_child", messageID: "child_a", type: "tool", tool: "glob" } });
  server.event("message.part.updated", { part: taskPart("running") });
  server.event("message.updated", { info: { id: "child_a", sessionID: "ses_child", role: "assistant", error: { name: "Private error" } } });
  server.event("message.part.updated", { part: { ...server.childMessages[0].parts[0], time: { end: 1 } } });
  server.event("message.part.delta", { sessionID: "ses_child", messageID: "child_a", partID: "child_text", field: "text", delta: "private" });
  server.event("session.status", { sessionID: "ses_child", status: { type: "idle" } });
  server.event("message.part.updated", { part: { id: "child_tool2", sessionID: "ses_child", messageID: "child_a", type: "tool", tool: "read" } });
  server.event("message.part.updated", { part: taskPart("completed") });
  const items = events.filter((e) => e.type === "item").map((e) => e.item);
  assert.deepEqual(items.map((i) => i.kind), ["subagent", "subagent", "subagent"]);
  assert.deepEqual(items.map((i) => i.kind === "subagent" && [i.status, i.activity]), [["running", "glob"], ["running", "read"], ["done", "read"]]);
  assert.equal(events.some((e) => e.type === "delta" || e.type === "turnEnded"), false);
  const history = await provider.history(ids.sessionID, "/tmp");
  assert.equal(history[0].id, items[0].id);
  assert.deepEqual(await provider.subagentHistory!(ids.sessionID, "/tmp", "prt_task"), normalizeMessages(server.childMessages));
  assert.deepEqual(await provider.subagentHistory!(ids.sessionID, "/tmp", "missing"), []);
  server.parentID = "unrelated";
  assert.deepEqual(await provider.subagentHistory!(ids.sessionID, "/tmp", "prt_task"), []);
  assert.equal(provider.limits, undefined);
  await session.close();
  assert.equal(server.releases, 5);
});

test("resumed tasks restore child routing without a session.created event", async () => {
  const server = new FakeOpencodeServer();
  server.parentMessages[0].parts = [taskPart("running")];
  const events: ProviderEvent[] = [];
  const provider = opencodeProvider(server);
  const session = provider.open({ cwd: "/tmp", config: {}, resumeId: ids.sessionID, emit: (e) => events.push(e), askPermission: async () => ({ decision: "allow" }), askQuestion: async () => null });
  await new Promise((r) => setImmediate(r));
  const childTool = { id: "child_tool", sessionID: "ses_child", messageID: "child_a", type: "tool", tool: "read" };
  server.event("message.part.updated", { part: { ...childTool, sessionID: "unrelated" } });
  assert.equal(events.filter((e) => e.type === "item").length, 0);
  server.event("message.part.updated", { part: childTool });
  assert.deepEqual(events.filter((e) => e.type === "item"), [{ type: "item", item: { kind: "subagent", id: "prt_task", title: "Inspect files", agentType: "explore", status: "running", activity: "read" } }]);
  await session.close();
  server.event("message.part.updated", { part: childTool });
  assert.equal(events.filter((e) => e.type === "item").length, 1);
});

test("OpenCode dispatch binds CASM prompt IDs to explicit native IDs before sending", async () => {
  const requests: { path: string; body: unknown }[] = [];
  class PromptServer extends FakeOpencodeServer {
    override async request<T>(method: string, path: string, directory?: string, body?: unknown): Promise<T> {
      if (path.endsWith("/prompt_async")) { requests.push({ path, body }); return {} as T; }
      return super.request<T>(method, path);
    }
  }
  const server = new PromptServer();
  const events: ProviderEvent[] = [];
  const session = opencodeProvider(server).open({ cwd: "/tmp", config: {}, resumeId: null,
    emit: (e) => events.push(e), askPermission: async () => ({ decision: "allow" }), askQuestion: async () => null });
  try {
    session.send("hello", "casm-id");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((requests[0].body as { messageID: string }).messageID, "msg_casmid");
    assert.deepEqual(events.find((e) => e.type === "userMessageId"), { type: "userMessageId", itemId: "casm-id", nativeId: "msg_casmid" });
  } finally { await session.close(); }
});

test("OpenCode MCP reconnect uses directory-scoped native endpoints and keeps disabled servers off", async () => {
  class McpServer extends FakeOpencodeServer {
    calls: string[] = [];
    override async request<T>(method: string, path: string, cwd?: string): Promise<T> {
      if (!path.startsWith("/mcp")) return super.request(method, path);
      assert.equal(cwd, "/tmp/mcp-project");
      this.calls.push(`${method} ${path}`);
      if (path === "/mcp") return { "docs/name": { status: "connected" }, off: { status: "disabled" } } as T;
      return true as T;
    }
  }
  const server = new McpServer();
  const session = opencodeProvider(server).open({ cwd: "/tmp/mcp-project", config: {}, resumeId: null, emit() {}, askPermission: async () => ({ decision: "deny" }), askQuestion: async () => null });
  try {
    assert.equal((await session.mcpStatus!())[0].toolsKnown, false);
    await session.mcpReconnect!("docs/name"); await session.mcpReconnect!();
    assert.equal(server.calls.filter((s) => s === "POST /mcp/docs%2Fname/connect").length, 2);
    assert.equal(server.calls.filter((s) => s === "POST /mcp/docs%2Fname/disconnect").length, 2);
    assert.ok(!server.calls.some((s) => s.includes("/off/")));
  } finally { await session.close(); }
});

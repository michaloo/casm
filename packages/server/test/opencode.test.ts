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

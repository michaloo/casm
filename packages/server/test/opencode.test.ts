import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMessages,
  normalizePart,
  parseCatalog,
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
    { kind: "notice", id: "msg_a2:error", text: "rate limited" },
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

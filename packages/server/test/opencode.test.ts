import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessages, normalizePart, type OcMessage, type OcPart } from "../src/providers/opencode.ts";

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

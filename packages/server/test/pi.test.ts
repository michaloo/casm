import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import { normalize, parseSession, type PiMessage } from "../src/providers/pi.ts";

type Tool = Extract<Item, { kind: "tool" }>;

// Shapes taken from real ~/.pi/agent/sessions files, trimmed and anonymized.
const assistant = (timestamp: number, content: unknown[], extra: Partial<PiMessage> = {}): PiMessage => ({
  role: "assistant",
  content,
  timestamp,
  stopReason: "stop",
  ...extra,
});

test("assistant blocks are keyed by message timestamp; tool calls complete from tool results", () => {
  const tools = new Map<string, Tool>();
  const call = normalize(
    assistant(
      1791747563172,
      [
        { type: "thinking", thinking: "Need to list files.", thinkingSignature: "reasoning_content" },
        { type: "text", text: "Listing." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      { stopReason: "toolUse" },
    ),
    tools,
  );
  assert.deepEqual(call, [
    { kind: "reasoning", id: "1791747563172:0", text: "Need to list files." },
    { kind: "assistant", id: "1791747563172:1", text: "Listing." },
    { kind: "tool", id: "call_1", name: "bash", input: { command: "ls" }, status: "running" },
  ]);
  const result = normalize(
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt\n" }],
      isError: false,
      timestamp: 1791747579346,
    },
    tools,
  );
  assert.deepEqual(result, [{ kind: "tool", id: "call_1", name: "bash", input: { command: "ls" }, status: "done", output: "a.txt\n" }]);
});

test("errors, aborts, empty blocks and long tool output", () => {
  const tools = new Map<string, Tool>();
  assert.deepEqual(normalize(assistant(5, [], { stopReason: "aborted" }), tools), []);
  assert.deepEqual(
    normalize(assistant(6, [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], { stopReason: "aborted" }), tools),
    [{ kind: "tool", id: "c", name: "bash", input: {}, status: "error" }],
  );
  assert.deepEqual(normalize(assistant(7, [{ type: "text", text: "  " }], { stopReason: "error", errorMessage: "503 overloaded" }), tools), [
    { kind: "notice", id: "7:error", text: "503 overloaded" },
  ]);
  const [big] = normalize(
    { role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "y".repeat(9000) }], isError: true },
    tools,
  );
  assert.equal(big.kind === "tool" && big.status, "error");
  assert.equal(big.kind === "tool" && big.name, "read");
  assert.ok(big.kind === "tool" && big.output!.endsWith("…(truncated)") && big.output!.length < 8100);
});

test("system messages are skipped; user text uses the entry id", () => {
  const tools = new Map<string, Tool>();
  assert.deepEqual(normalize({ role: "system", content: "", timestamp: 1 }, tools, "e0"), []);
  assert.deepEqual(normalize({ role: "user", content: [{ type: "text", text: "hu" }], timestamp: 2 }, tools, "e1"), [
    { kind: "user", id: "e1", text: "hu" },
  ]);
});

const line = (o: object) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, message: PiMessage) => line({ type: "message", id, parentId, timestamp: "2026-10-11T19:39:09.766Z", message });

const session = [
  line({ type: "session", version: 3, id: "01a1-uuid", timestamp: "2026-10-11T19:39:09.442Z", cwd: "/work" }),
  line({ type: "model_change", id: "m0", parentId: null, timestamp: "t", provider: "llama-server", modelId: "small" }),
  msg("s0", "m0", { role: "system", content: "", timestamp: 100 }),
  msg("u1", "s0", { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 101 }),
  msg("a1", "u1", assistant(102, [{ type: "thinking", thinking: "greet" }, { type: "text", text: "Hi!" }])),
  // Abandoned branch: not on the active path.
  msg("u2x", "a1", { role: "user", content: [{ type: "text", text: "old question" }], timestamp: 103 }),
  msg("a2x", "u2x", assistant(104, [{ type: "text", text: "old answer" }])),
  line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Greeted the user.", firstKeptEntryId: "u1", tokensBefore: 10 }),
  msg("u2", "c1", { role: "user", content: [{ type: "text", text: "list files" }], timestamp: 105 }),
  msg("a2", "u2", assistant(106, [{ type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" })),
  msg("r2", "a2", { role: "toolResult", toolCallId: "call_9", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 107 }),
  msg("a3", "r2", assistant(108, [{ type: "text", text: "One file." }])),
  "{not json",
  "",
].join("\n");

test("parseSession follows the active branch and upserts tool results", () => {
  assert.deepEqual(parseSession(session), [
    { kind: "user", id: "u1", text: "hello" },
    { kind: "reasoning", id: "102:0", text: "greet" },
    { kind: "assistant", id: "102:1", text: "Hi!" },
    { kind: "notice", id: "c1", text: "Context compacted: Greeted the user." },
    { kind: "user", id: "u2", text: "list files" },
    { kind: "tool", id: "call_9", name: "bash", input: { command: "ls" }, status: "done", output: "a.txt" },
    { kind: "assistant", id: "108:0", text: "One file." },
  ]);
});

test("an empty or header-only session has no items", () => {
  assert.deepEqual(parseSession(""), []);
  assert.deepEqual(parseSession(line({ type: "session", version: 3, id: "x", cwd: "/" })), []);
});

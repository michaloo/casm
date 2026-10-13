import { test } from "node:test";
import assert from "node:assert/strict";
import { Normalizer } from "../src/providers/claude.ts";

const start = (n: Normalizer, id = "tool-1", name = "Write", index = 0) => n.stream({
  type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} },
});
const delta = (n: Normalizer, partial_json: string, index = 0) => n.stream({
  type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json },
});
const stop = (n: Normalizer, index = 0) => n.stream({ type: "content_block_stop", index });
const assistant = (n: Normalizer, input: unknown, id = "tool-1", name = "Write") => n.entry({
  type: "assistant", uuid: "message-1", message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (n: Normalizer, id = "tool-1") => n.entry({
  type: "user", uuid: "result-1", message: { content: [{ type: "tool_result", tool_use_id: id, content: "saved" }] },
});

test("Claude tool appears at block start, previews incomplete input, then keeps its ID through completion", () => {
  const n = new Normalizer();
  assert.deepEqual(start(n), [{ kind: "tool", id: "tool-1", name: "Write", input: {}, status: "running" }]);
  const first = delta(n, '{"file_path":"/tmp/example","content":"');
  assert.equal(first[0]?.input, '{"file_path":"/tmp/example","content":"');
  assert.equal(delta(n, 'hello\\nworld"}').length, 0); // Small fragments coalesce.
  const input = { file_path: "/tmp/example", content: "hello\nworld" };
  assert.deepEqual(stop(n)[0]?.input, input);
  assert.deepEqual(assistant(n, input)[0], { kind: "tool", id: "tool-1", name: "Write", input, status: "running" });
  assert.deepEqual(result(n)[0], { kind: "tool", id: "tool-1", name: "Write", input, status: "done", output: "saved" });
  assert.deepEqual(n.endTurn(), []);
});

test("Claude keeps interleaved input blocks separate and rejects late chunks after final tool records", () => {
  const n = new Normalizer();
  start(n, "a", "Read", 0);
  start(n, "b", "Bash", 1);
  delta(n, '{"file_path":"/a"}', 0);
  delta(n, '{"command":"pwd"}', 1);
  assistant(n, { file_path: "/a" }, "a", "Read");
  assert.deepEqual(delta(n, "late", 0), []);
  result(n, "b");
  assert.deepEqual(delta(n, "late", 1), []);
  assert.deepEqual(start(n, "b", "Bash", 1), []);
  const late = assistant(n, { command: "pwd" }, "b", "Bash")[0];
  assert.equal(late?.kind, "tool");
  if (late?.kind === "tool") assert.equal(late.status, "done");
});

test("Claude caps streaming previews while the final assistant input remains authoritative", () => {
  const n = new Normalizer();
  start(n);
  delta(n, '{"content":"');
  const preview = delta(n, "x".repeat(20_000))[0];
  assert.equal(typeof preview.input, "string");
  assert.ok((preview.input as string).length < 8100);
  assert.match(preview.input as string, /input preview truncated/);
  assert.deepEqual(delta(n, "x".repeat(20_000)), []);
  const input = { content: "x".repeat(40_000) };
  const final = assistant(n, input)[0];
  assert.ok(final?.kind === "tool");
  assert.deepEqual(final.input, input);
});

test("Claude input snapshots are bounded even when arguments arrive one character at a time", () => {
  const n = new Normalizer();
  start(n);
  let updates = 0;
  for (const char of '{"content":"' + "x".repeat(9000) + '"}') updates += delta(n, char).length;
  assert.ok(updates < 70);
  assert.ok(updates > 1);
});

test("Claude clears stream indexes at message boundaries and marks abandoned drafts at turn end", () => {
  const n = new Normalizer();
  start(n);
  delta(n, '{"content":"unfinished');
  n.stream({ type: "message_stop" });
  assert.deepEqual(delta(n, "late"), []);
  start(n, "next"); // Same index in the next message is a different tool.
  delta(n, '{"content":"next"}');
  assistant(n, { content: "next" }, "next");
  const abandoned = n.endTurn();
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].id, "tool-1");
  assert.equal(abandoned[0].status, "error");
  assert.match(abandoned[0].output!, /before execution/);
  assert.deepEqual(delta(n, "late"), []);
  assert.deepEqual(n.endTurn(), []);
  assert.equal(n.tools.get("next")?.status, "running"); // Actual tool execution is separate.
});

test("Claude keeps plan tools hidden and ignores unknown/non-input stream deltas", () => {
  const n = new Normalizer();
  for (const name of ["TaskCreate", "TaskUpdate", "TodoWrite"]) {
    assert.deepEqual(start(n, name, name), []);
    assert.deepEqual(delta(n, '{"subject":"task"}'), []);
  }
  assert.deepEqual(delta(n, "orphaned", 10), []);
  start(n);
  assert.deepEqual(n.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }), []);
  assert.deepEqual(delta(n, ""), []);
});

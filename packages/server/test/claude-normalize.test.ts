import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import { normalize } from "../src/providers/claude.ts";

test("normalizes a tool call and completes it from the tool result", () => {
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const call = normalize(
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look" },
          { type: "text", text: "Reading it." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
        ],
      },
    },
    tools,
  );
  assert.deepEqual(
    call.map((i) => i.kind),
    ["reasoning", "assistant", "tool"],
  );
  const result = normalize(
    {
      type: "user",
      uuid: "u2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "contents" }] }] },
    },
    tools,
  );
  assert.deepEqual(result, [{ kind: "tool", id: "t1", name: "Read", input: { file_path: "/x" }, status: "done", output: "contents" }]);
});

test("user prompts become user items; empty text is skipped", () => {
  const tools = new Map();
  assert.deepEqual(normalize({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }, tools), [
    { kind: "user", id: "u1", text: "hi" },
  ]);
  assert.deepEqual(normalize({ type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "  " }] } }, tools), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
// Load the state reducer without the browser WebSocket client.
const source = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");
// Its imports resolve to the source files.
const output = stripTypeScriptTypes(source.slice(0, source.indexOf("export class Rpc")))
  .replace('"./image-preview"', JSON.stringify(new URL("../src/image-preview.ts", import.meta.url).href))
  .replace('"@casm/protocol"', JSON.stringify(new URL("../../protocol/src/index.ts", import.meta.url).href));
const { chat, chats, event } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
test("snapshot replay does not fabricate completed tool durations", () => {
  chats.delete("image-timing");
  const c = chat("image-timing");
  event(c, { type: "item", item: { kind: "tool", id: "t", name: "test", input: {}, status: "running" } }, true);
  event(c, { type: "item", item: { kind: "tool", id: "t", name: "test", input: {}, status: "done" } }, true);
  assert.equal(c.toolTimes?.t, undefined);
  event(c, { type: "item", item: { kind: "tool", id: "live", name: "test", input: {}, status: "running" } });
  event(c, { type: "item", item: { kind: "tool", id: "live", name: "test", input: {}, status: "done" } });
  assert.ok(c.toolTimes?.live.end);
});
test("streamed tool output follows a running tool, keeps its tail, and stops at the result", () => {
  chats.delete("live-output");
  const c = chat("live-output");
  const tool = (status: string, output?: string) => ({ type: "item", item: { kind: "tool", id: "t", name: "Bash", input: {}, status, ...(output === undefined ? {} : { output }) } });
  event(c, tool("running"));
  event(c, { type: "toolOutput", itemId: "t", text: "line 1" });
  event(c, { type: "toolOutput", itemId: "t", text: "\nline 2" });
  assert.equal(c.items[0].output, "line 1\nline 2");
  event(c, { type: "toolOutput", itemId: "t", text: "\n" + "x".repeat(70 * 1024) + "\nlast" });
  assert.equal(c.items[0].output, "…\nlast");
  event(c, tool("done", "the result"));
  // A read that raced the result doesn't add to it.
  event(c, { type: "toolOutput", itemId: "t", text: "\nline 3" });
  assert.equal(c.items[0].output, "the result");
});

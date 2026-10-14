import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
// Load the state reducer without the browser WebSocket client.
const source = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");
const output = stripTypeScriptTypes(source.slice(0, source.indexOf("export class Rpc")));
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

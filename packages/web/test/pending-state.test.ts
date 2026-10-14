import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
// State-only module, without the browser RPC client's Vite environment.
const source = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");
const output = stripTypeScriptTypes(source.slice(0, source.indexOf("export class Rpc")));
const { chat, syncPending } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

test("an older history/notification snapshot cannot erase a newer pending queue", async () => {
  const c = chat("pending-race");
  const older = Promise.withResolvers();
  const first = syncPending(c, () => older.promise);
  const messages = [{ id: "queued", text: "sent from another client" }];
  assert.equal(await syncPending(c, async () => ({ messages })), true);
  older.resolve({ messages: [] });
  assert.equal(await first, false);
  assert.deepEqual(c.pending, messages);
});

test("pending request ordering is per chat and newer empty snapshots remove delivered messages", async () => {
  const a = chat("host/a");
  const b = chat("host/b");
  const delayed = Promise.withResolvers();
  const first = syncPending(a, () => delayed.promise);
  await syncPending(b, async () => ({ messages: [{ id: "b" }] }));
  delayed.resolve({ messages: [{ id: "a" }] });
  assert.equal(await first, true);
  assert.deepEqual(a.pending, [{ id: "a" }]);
  assert.deepEqual(b.pending, [{ id: "b" }]);
  await syncPending(a, async () => ({ messages: [] }));
  assert.deepEqual(a.pending, []);
});

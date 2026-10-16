import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
// State-only module, without the browser RPC client's Vite environment.
const source = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");
// Its one local import resolves to the source file.
const output = stripTypeScriptTypes(source.slice(0, source.indexOf("export class Rpc")))
  .replace('"./image-preview"', JSON.stringify(new URL("../src/image-preview.ts", import.meta.url).href));
const { chat, syncPending, replaceHistory, event } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

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

test("reconnect preserves in-flight sends and reconciles confirmed and queued identities", () => {
  const c = chat("reconnect-send");
  const item = { kind: "user", id: "sending", text: "hello" };
  c.items = [item];
  c.inFlight = new Map([[item.id, item]]);
  replaceHistory(c, []);
  assert.deepEqual(c.items, [item]);
  const confirmed = { ...item, text: "confirmed" };
  replaceHistory(c, [confirmed]);
  assert.deepEqual(c.items, [confirmed]);
  event(c, { type: "item", item: confirmed });
  assert.deepEqual(c.items, [confirmed]);
  c.pending = [{ id: item.id }];
  replaceHistory(c, []);
  assert.deepEqual(c.items, []);
  c.pending = [];
  c.inFlight.delete(item.id);
  replaceHistory(c, []);
  assert.deepEqual(c.items, []);
});

test("reopening a chat mid-turn shows a prompt once when history and the live replay share its id", () => {
  const c = chat("host/reopen");
  const prompt = { kind: "user", id: "0dbfa9c4-1785-4a50-98ef-b8fcc65a28e5", text: "Benchmark this" };
  replaceHistory(c, [prompt]);
  for (const e of [{ type: "turnStarted", turnId: "t" }, { type: "item", item: prompt }, { type: "item", item: { kind: "assistant", id: "a", text: "ok" } }]) event(c, e, true);
  assert.deepEqual(c.items.map((i) => i.id), [prompt.id, "a"]);
});

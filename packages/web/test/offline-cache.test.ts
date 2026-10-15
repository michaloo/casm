import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import { MemoryStore, OfflineCache, SCHEMA, defaultLimits, fingerprint, reconcile, trimItem } from "../src/offline-cache.ts";

const items = (from: number, to: number): Item[] =>
  Array.from({ length: to - from }, (_, i) => ({ kind: "assistant", id: `m${from + i}`, text: `message ${from + i}` }));
const chat = (list: Item[], start = 0) => ({ items: list, start, pending: [] });

async function opened(limits = defaultLimits, token = "token-a") {
  const store = new MemoryStore();
  const cache = new OfflineCache(store, limits);
  await cache.open(token);
  return { store, cache };
}

test("a transcript keeps its last items and their position", async () => {
  const { cache } = await opened({ ...defaultLimits, items: 200 });
  await cache.saveChat("/a", chat(items(0, 320), 1000));
  const saved = await cache.chat("/a");
  assert.equal(saved!.items.length, 200);
  assert.equal(saved!.items[0].id, "m120");
  assert.equal(saved!.start, 1120);
});

test("image data is dropped and huge tool output is truncated", () => {
  const user = trimItem({ kind: "user", id: "u", text: "see", images: [{ mediaType: "image/png", data: "AAAA" }] });
  assert.deepEqual(user, { kind: "user", id: "u", text: "see", images: [{ mediaType: "image/png" }] });
  const tool = trimItem({ kind: "tool", id: "t", name: "Write", status: "done", input: { path: "x", content: "y".repeat(50_000) },
    output: "z".repeat(50_000), images: [{ mediaType: "image/png", data: "BBBB" }] }, { ...defaultLimits, output: 100 });
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") return;
  assert.ok(tool.output!.length < 200);
  assert.match(tool.output!, /49900 more characters not saved offline/);
  assert.equal((tool.input as any).path, "x");
  assert.ok((tool.input as any).content.length < 200);
  assert.deepEqual(tool.images, [{ mediaType: "image/png" }]);
});

test("least recently opened transcripts are evicted beyond the count", async () => {
  const { cache } = await opened({ ...defaultLimits, chats: 3 });
  for (const [i, k] of ["/a", "/b", "/c"].entries()) await cache.saveChat(k, chat(items(0, 5)), i);
  // Opening /a makes /b the least recently used.
  await cache.chat("/a", 10);
  await cache.saveChat("/d", chat(items(0, 5)), 11);
  assert.deepEqual(await cache.saved(), ["/d", "/a", "/c"]);
  assert.equal(await cache.chat("/b"), undefined);
});

test("the size budget evicts the oldest transcripts and refuses one too large", async () => {
  const one = JSON.stringify({ items: items(0, 50), start: 0, pending: [], savedAt: 0 }).length;
  const { cache, store } = await opened({ ...defaultLimits, bytes: one * 2.5 });
  await cache.saveChat("/a", chat(items(0, 50)), 1);
  await cache.saveChat("/b", chat(items(0, 50)), 2);
  await cache.saveChat("/c", chat(items(0, 50)), 3);
  assert.deepEqual(await cache.saved(), ["/c", "/b"]);
  assert.equal(store.data.has("chat:/a"), false);
  await cache.saveChat("/huge", chat(items(0, 500)), 4);
  assert.deepEqual(await cache.saved(), ["/c", "/b"]);
});

test("the sidebar keeps a failed host's previous projects and agents", async () => {
  const { cache } = await opened();
  const project = { id: "p", name: "P", path: "/p", sort: 0 } as any;
  await cache.saveSidebar([{ id: "", name: "local", projects: [project], agents: [] }, { id: "peer", name: "peer", projects: [project], agents: [] }], 1);
  await cache.saveSidebar([{ id: "", name: "local", projects: [], agents: [] }, { id: "peer", name: "peer", projects: [], agents: [], error: "down" }], 2);
  const saved = await cache.sidebar();
  assert.equal(saved!.savedAt, 2);
  assert.deepEqual(saved!.hosts.map((h) => [h.id, h.projects.length]), [["", 0], ["peer", 1]]);
});

test("another token's copy is cleared, the same token's kept", async () => {
  const { cache, store } = await opened();
  await cache.saveChat("/a", chat(items(0, 3)));
  await cache.open("token-a");
  assert.ok(await cache.chat("/a"));
  await cache.open("token-b");
  assert.equal(await cache.chat("/a"), undefined);
  assert.equal(((await store.get("meta")) as any).owner, fingerprint("token-b"));
  assert.notEqual(fingerprint("token-a"), fingerprint("token-b"));
});

test("an older schema migrates; a gap or a newer schema clears", async () => {
  const { cache, store } = await opened();
  await cache.saveChat("/a", chat(items(0, 3)));
  // Schema 2 renames message text; the step runs once.
  let runs = 0;
  const steps = {
    [SCHEMA]: async (s: MemoryStore) => {
      runs++;
      const c = (await s.get("chat:/a")) as any;
      c.items = c.items.map((i: any) => ({ ...i, text: i.text.toUpperCase() }));
      await s.put("chat:/a", c);
    },
  } as any;
  await cache.open("token-a", SCHEMA + 1, steps);
  await cache.open("token-a", SCHEMA + 1, steps);
  assert.equal(runs, 1);
  assert.equal((await cache.chat("/a"))!.items[0].kind === "assistant" && ((await cache.chat("/a"))!.items[0] as any).text, "MESSAGE 0");
  assert.equal(((await store.get("meta")) as any).schema, SCHEMA + 1);
  // No step from schema 2 to 4: start over.
  await cache.open("token-a", SCHEMA + 3, steps);
  assert.equal(await cache.chat("/a"), undefined);
  // Back to an older client: a newer copy is not read.
  await cache.saveChat("/b", chat(items(0, 3)));
  await cache.open("token-a", SCHEMA);
  assert.equal(await cache.chat("/b"), undefined);
});

test("reconcile keeps earlier rows that line up and never duplicates", () => {
  // Saved 200..259; the server's latest page is 220..279.
  const merged = reconcile(items(200, 260), 200, items(220, 280), 220);
  assert.equal(merged.start, 200);
  assert.deepEqual(merged.items.map((i) => i.id), items(200, 280).map((i) => i.id));
  assert.equal(new Set(merged.items.map((i) => i.id)).size, merged.items.length);
  // A rewritten history (compaction): positions don't match, the fresh page wins.
  const rewritten = reconcile(items(200, 260), 200, items(220, 280), 150);
  assert.deepEqual(rewritten, { items: items(220, 280), start: 150 });
  // No overlap: only the fresh page.
  assert.deepEqual(reconcile(items(0, 10), 0, items(50, 60), 50).items.length, 10);
  // Duplicates inside a page are dropped too.
  assert.deepEqual(reconcile([], 0, [...items(0, 2), ...items(1, 3)], 0).items.map((i) => i.id), ["m0", "m1", "m2"]);
});

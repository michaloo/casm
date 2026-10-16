import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import type { Chat } from "../src/state.ts";
import { pageAround, shownIndex, showPage, windowNewer, windowOlder } from "../src/find-window.ts";

const all: Item[] = Array.from({ length: 1000 }, (_, i) => ({ kind: "assistant", id: `m${i}`, text: `message ${i}` }));
const chat = (_: string) => ({ items: [], start: 0 }) as unknown as Chat;
const read = (before: number, limit: number) => {
  const end = Math.min(before, all.length);
  const start = Math.max(0, end - limit);
  return { items: all.slice(start, end), start };
};

test("a far match shows a window; paging newer joins the live transcript without gaps", () => {
  const c = chat("find-window-a");
  c.items = all.slice(900); c.start = 900;
  const { before, limit } = pageAround(120);
  assert.equal(showPage(c, read(before, limit)), "window");
  assert.deepEqual([c.window!.start, c.window!.items.length], [70, 100]);
  assert.equal(shownIndex(c, "m120", 120), 50);
  // The live part is untouched meanwhile.
  assert.equal(c.start, 900);
  windowOlder(c, read(c.window!.start, 100));
  assert.deepEqual([c.window!.start, c.window!.items[0].id], [0, "m0"]);
  for (let i = 0; i < 20 && c.window; i++) windowNewer(c, read(c.window.start + c.window.items.length + 100, 100));
  assert.equal(c.window, undefined);
  assert.equal(c.start, 0);
  assert.deepEqual(c.items.map((i) => i.id), all.map((i) => i.id));
});

test("a match just before the loaded pages is prepended, not windowed", () => {
  const c = chat("find-window-b");
  c.items = all.slice(900); c.start = 900;
  const { before, limit } = pageAround(860);
  assert.equal(showPage(c, read(before, limit)), "live");
  assert.equal(c.window, undefined);
  assert.equal(c.start, 810);
  assert.equal(c.items[0].id, "m810");
  assert.equal(new Set(c.items.map((i) => i.id)).size, c.items.length);
  assert.equal(shownIndex(c, "m860", 860), 50);
});

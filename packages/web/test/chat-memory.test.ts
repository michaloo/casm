import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { readChatMemory, recentChats, writeChatMemory } from "../src/chat-memory.ts";
const source = readFileSync(new URL("../src/state.ts", import.meta.url), "utf8");
const output = stripTypeScriptTypes(source.slice(0, source.indexOf("export class Rpc")))
  .replace('"./image-preview"', JSON.stringify(new URL("../src/image-preview.ts", import.meta.url).href));
const { chat, chats, event, evict, hold, leave } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const { imageSource } = await import("../src/image-preview.ts");

test("the setting defaults to recent 20 and ignores unknown values", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(readChatMemory(storage), "20");
  writeChatMemory(storage, "5");
  assert.equal(readChatMemory(storage), "5");
  store.set("casm.chat-memory", "999");
  assert.equal(readChatMemory(storage), "20");
  assert.equal(recentChats("5"), 4);
  assert.equal(recentChats("all"), Infinity);
});

test("only the open chat and the most recent ones stay; busy chats wait", () => {
  for (let i = 0; i < 6; i++) chat(`lru/${i}`).loaded = true;
  chat("lru/1").inFlight = new Map([["m", { kind: "user", id: "m", text: "sending" }]]);
  const dropped: string[] = [];
  for (let i = 0; i < 6; i++) dropped.push(...leave(`lru/${i}`, 2));
  // Open: 5; recent: 4, 3; 1 is still sending.
  assert.deepEqual(dropped, ["lru/0", "lru/2"]);
  chat("lru/1").inFlight = undefined;
  assert.deepEqual(leave("lru/4", 2), ["lru/1"]);
  // Reopening a recent chat moves it to the front.
  assert.deepEqual(leave("lru/3", 2), []);
});

test("a dropped chat forgets its rows but keeps drafts, flags and the queue", () => {
  chats.delete("drop");
  const c = chat("drop");
  c.loaded = true;
  c.input = "half-typed";
  c.pending = [{ id: "p", text: "queued" }];
  c.expanded = { "tool-1": true };
  c.toolTimes = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`t${i}`, { start: i }]));
  event(c, { type: "item", item: { kind: "assistant", id: "a", text: "hello" } });
  evict(c);
  assert.deepEqual([c.items.length, c.loaded, c.input, c.pending.length, c.expanded["tool-1"]], [0, false, "half-typed", 1, true]);
  assert.equal(Object.keys(c.toolTimes).length, 200);
  // Live rows are ignored until the chat is loaded again; turn state is not.
  event(c, { type: "item", item: { kind: "assistant", id: "b", text: "missed" } });
  event(c, { type: "delta", kind: "assistant", text: "streamed" });
  event(c, { type: "turnEnded", outcome: "failed" });
  assert.deepEqual([c.items.length, c.draft, c.failed], [0, "", true]);
});

test("inline images are held as Blobs, shown through one blob URL", async () => {
  const data = Buffer.from("png bytes").toString("base64");
  const item = hold({ kind: "tool", id: "t", name: "Read", input: {}, status: "done", images: [{ mediaType: "image/png", data }, { mediaType: "image/svg+xml", data }] });
  assert.equal(item.images[0].data, undefined);
  assert.equal(item.images[1].data, undefined);
  const url = imageSource(item.images[0]);
  assert.match(url, /^blob:/);
  assert.equal(imageSource(item.images[0]), url);
  assert.equal(await (await fetch(url)).text(), "png bytes");
  // Never shown, so nothing is kept.
  assert.equal(imageSource(item.images[1]), undefined);
  // Items without inline data are kept as they are.
  const text = { kind: "user", id: "u", text: "hi" };
  assert.equal(hold(text), text);
});

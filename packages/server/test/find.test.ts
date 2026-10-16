import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import type { Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { findInItems } from "../src/find.ts";
import type { Provider } from "../src/providers/types.ts";

const items: Item[] = [
  { kind: "user", id: "u1", at: "2026-10-01T10:00:00Z", text: "Fix the Parser\nplease" },
  { kind: "reasoning", id: "r1", text: "The parser is in src/parser.ts" },
  { kind: "tool", id: "t1", name: "Bash", input: { command: "grep -n parser src" }, status: "done", output: "x".repeat(300) + "parser(" },
  { kind: "subagent", id: "s1", title: "Review parser", status: "done", summary: "parser ok" },
  { kind: "notice", id: "n1", text: "Compacted" },
  { kind: "plan", id: "p1", entries: [{ text: "write parser tests", status: "pending" }] },
  { kind: "assistant", id: "a1", text: "Done: parser fixed." },
];

test("find: smart case, every field, snippets with the match offsets", () => {
  const r = findInItems(items, "parser");
  assert.equal(r.total, 9);
  assert.deepEqual(r.matches.map((m) => [m.index, m.kind, m.field]), [
    [0, "user", "text"], [1, "reasoning", "text"], [1, "reasoning", "text"], [2, "tool", "input"], [2, "tool", "output"],
    [3, "subagent", "title"], [3, "subagent", "summary"], [5, "plan", "text"], [6, "assistant", "text"],
  ]);
  for (const m of r.matches) assert.equal(m.snippet.text.slice(m.snippet.start, m.snippet.end).toLowerCase(), "parser");
  // One line, the newline kept as a space so offsets still count.
  assert.equal(r.matches[0].snippet.text, "Fix the Parser please");
  assert.equal(r.matches[0].at, "2026-10-01T10:00:00Z");
  const out = r.matches[4];
  assert.equal(out.offset, 300);
  assert.ok(out.snippet.text.startsWith("…") && out.snippet.start === 41);
  // A capital makes it case-sensitive.
  assert.deepEqual(findInItems(items, "Parser").matches.map((m) => m.itemId), ["u1"]);
  // Regex characters are literal.
  assert.deepEqual(findInItems(items, "parser(").matches.map((m) => m.field), ["output"]);
  assert.equal(findInItems(items, "src/").total, 1);
  assert.equal(findInItems(items, "src").total, 2);
});

test("find: kinds filter, and past the limit only the latest matches", () => {
  assert.deepEqual(findInItems(items, "parser", { kinds: ["reasoning", "tool"] }).matches.map((m) => m.itemId), ["r1", "r1", "t1", "t1"]);
  const many: Item[] = Array.from({ length: 3000 }, (_, i) => ({ kind: "assistant", id: `a${i}`, text: `hit ${i} hit` }));
  const r = findInItems(many, "hit", { limit: 500 });
  assert.equal(r.total, 6000);
  assert.equal(r.matches.length, 500);
  assert.deepEqual([r.matches[0].index, r.matches.at(-1)!.index], [2750, 2999]);
  assert.deepEqual(findInItems(many, "hit", { limit: 0 }), { total: 6000, matches: [] });
});

test("find: thousands of items search in a few milliseconds", () => {
  const big: Item[] = [];
  for (let i = 0; i < 5000; i++)
    big.push(
      { kind: "assistant", id: `a${i}`, text: `Reply ${i}: ${"lorem ipsum dolor sit amet ".repeat(40)}` },
      { kind: "tool", id: `t${i}`, name: "Read", input: { file_path: `/src/file${i}.ts` }, status: "done", output: "const x = 1;\n".repeat(400) },
    );
  const started = performance.now();
  const r = findInItems(big, "file4999");
  const ms = performance.now() - started;
  assert.equal(r.total, 1);
  assert.ok(ms < 1000, `${ms}ms for 10000 items`);
});

test("agent.find searches every session: indexes match agent.history pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-find-"));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "find", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: dir, config: {} });
  const token = store.createToken("test");
  const sessions = new Map<string, Item[]>();
  const provider: Provider = {
    id: "claude",
    open(opts) {
      const native = opts.resumeId ?? `native-${sessions.size}`;
      if (!sessions.has(native)) sessions.set(native, []);
      opts.emit({ type: "sessionId", id: native });
      return {
        send(text, itemId) {
          const s = sessions.get(native)!;
          // Long sessions, so matches fall on different pages.
          for (let i = 0; i < 150; i++) s.push({ kind: "assistant", id: `${itemId}-${i}`, text: `${text} filler ${i}` });
          s.push({ kind: "tool", id: `${itemId}-tool`, name: "Bash", input: { command: `echo ${text}` }, status: "done", output: `needle in ${text}` });
          setImmediate(() => opts.emit({ type: "turnEnded", outcome: "completed" }));
        },
        shell() {}, async interrupt() {}, async close() {},
      };
    },
    async history(native) { return sessions.get(native) ?? []; },
    async catalog() { return { models: [], modes: [] }; },
    async commands() { return []; },
    async usage() { return null; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    await client.call("agent.send", { id: agent.id, text: "one" });
    await client.call("agent.wait", { id: agent.id });
    await client.call("agent.restart", { id: agent.id });
    await client.call("agent.send", { id: agent.id, text: "two" });
    await client.call("agent.wait", { id: agent.id });
    const r = await client.call("agent.find", { id: agent.id, query: "needle" });
    assert.equal(r.total, 2);
    assert.deepEqual(r.matches.map((m) => [m.index, m.field]), [[150, "output"], [302, "output"]]);
    assert.ok(r.matches[0].itemId.startsWith("past0:"));
    for (const m of r.matches) {
      const page = await client.call("agent.history", { id: agent.id, before: m.index + 1, limit: 100 });
      assert.equal(page.items.at(-1)!.id, m.itemId);
      assert.equal(page.start + page.items.length - 1, m.index);
    }
    // The restart divider is searchable too.
    assert.deepEqual((await client.call("agent.find", { id: agent.id, query: "session restarted" })).matches.map((m) => [m.index, m.kind]), [[151, "notice"]]);
    await assert.rejects(client.call("agent.find", { id: agent.id, query: "" }));
  } finally {
    client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

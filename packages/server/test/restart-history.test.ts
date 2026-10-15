import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import type { Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

test("restart keeps the old session in the history before a divider, and only the new one is resumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-restart-"));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "restart", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: dir, config: {} });
  const token = store.createToken("test");
  const sessions = new Map<string, Item[]>();
  const resumed: (string | null | undefined)[] = [];
  const provider: Provider = {
    id: "claude",
    open(opts) {
      resumed.push(opts.resumeId);
      const native = opts.resumeId ?? `native-${sessions.size}`;
      if (!sessions.has(native)) sessions.set(native, []);
      opts.emit({ type: "sessionId", id: native });
      return {
        send(text, itemId) {
          sessions.get(native)!.push({ kind: "user", id: itemId, text }, { kind: "assistant", id: `${itemId}-reply`, text: `re ${text}` });
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
    const restarted = await client.call("agent.history", { id: agent.id });
    assert.deepEqual(restarted.items.map((i) => i.kind), ["user", "assistant", "notice"]);
    assert.ok(restarted.items[2].kind === "notice" && restarted.items[2].restart);
    await client.call("agent.send", { id: agent.id, text: "two" });
    await client.call("agent.wait", { id: agent.id });
    assert.deepEqual(resumed, [null, null]);
    const all = (await client.call("agent.history", { id: agent.id })).items;
    assert.deepEqual(all.map((i) => i.kind === "notice" ? "|" : "text" in i ? i.text : i.kind), ["one", "re one", "|", "two", "re two"]);
    assert.equal(new Set(all.map((i) => i.id)).size, all.length);
    assert.ok(all[0].id.startsWith("past0:"));
    // Pages count across the sessions.
    assert.deepEqual((await client.call("agent.history", { id: agent.id, before: 3, limit: 2 })).items, all.slice(1, 3));
  } finally {
    client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import type { AgentEvent, Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { piProvider } from "../src/providers/pi.ts";
import type { Provider } from "../src/providers/types.ts";

test("sender persists through queued restart delivery, native ID aliases and history pagination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-sender-"));
  const file = join(dir, "state.db");
  let store = new Store(file);
  const project = store.createProject({ name: "sender", path: dir });
  const recipient = store.createAgent({ projectId: project.id, name: "recipient", provider: "claude", cwd: dir, config: {} });
  const source = { serverId: "remote-server", agentId: "remote-agent", name: "Coordinator" };
  const queued = store.addPending({ agentId: recipient.id, text: "identical", sender: source, reason: "queued", notBefore: null, note: null });
  const token = store.createToken("test");
  store.close();
  store = new Store(file);
  assert.deepEqual(store.listPending(recipient.id)[0].sender, source);
  const history: Item[] = [];
  const provider: Provider = {
    id: "claude",
    open(opts) {
      opts.emit({ type: "sessionId", id: "native-session" });
      return {
        send(text, itemId) {
          const nativeId = `native-${itemId}`;
          opts.emit({ type: "userMessageId", itemId, nativeId });
          history.push({ kind: "user", id: nativeId, text });
          setImmediate(() => opts.emit({ type: "turnEnded", outcome: "completed" }));
        },
        shell() {}, async interrupt() {}, async close() {},
      };
    },
    async history() { return history; },
    async catalog() { return { models: [], modes: [] }; },
    async commands() { return []; },
    async usage() { return null; },
  };
  let server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  let client = await CasmClient.connect(server.url, token);
  try {
    await client.call("agent.wait", { id: recipient.id });
    assert.equal(store.listPending(recipient.id).length, 0);
    assert.deepEqual(store.messageSender(recipient.id, queued.id), source);
    const events: AgentEvent[] = [];
    client.on("agent.event", (n) => events.push(n.event));
    await client.call("agent.subscribe", { id: recipient.id });
    await client.call("agent.send", { id: recipient.id, text: "identical", sender: source });
    await client.call("agent.wait", { id: recipient.id });
    const users = events.flatMap((e) => e.type === "item" && e.item.kind === "user" ? [e.item] : []);
    assert.deepEqual(users.map((item) => item.sender), [source]);
    await client.call("agent.send", { id: recipient.id, text: "identical" });
    await client.call("agent.wait", { id: recipient.id });
    client.close();
    await server.close();
    store.close();
    store = new Store(file);
    server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
    client = await CasmClient.connect(server.url, token);
    const all = (await client.call("agent.history", { id: recipient.id })).items;
    assert.deepEqual(all.map((i) => i.kind === "user" && i.sender), [source, source, undefined]);
    assert.deepEqual((await client.call("agent.history", { id: recipient.id, before: 2, limit: 1 })).items, [all[1]]);
  } finally {
    client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing pending tables migrate without attributing legacy human messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-sender-migration-"));
  const file = join(dir, "state.db");
  let store = new Store(file);
  try {
    const p = store.createProject({ name: "legacy", path: dir });
    const a = store.createAgent({ projectId: p.id, name: "a", provider: "claude", cwd: dir, config: {} });
    store.addPending({ agentId: a.id, text: "legacy", reason: "queued", notBefore: null, note: null });
    store.db.exec("ALTER TABLE pending DROP COLUMN sender");
    store.close();
    store = new Store(file);
    assert.equal(store.listPending(a.id)[0].sender, undefined);
    assert.equal(store.listPending(a.id)[0].text, "legacy");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi history aliases use native timestamps without replacing stable disk entry IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-pi-sender-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "message", id: "native-entry", parentId: null,
    message: { role: "user", timestamp: 12345, content: "hello" } }) + "\n");
  try {
    const provider = piProvider();
    assert.deepEqual(await provider.historyAliases!(file, dir), { "native-entry": "pi:12345" });
    assert.deepEqual(await provider.history(file, dir), [{ kind: "user", id: "native-entry", text: "hello" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

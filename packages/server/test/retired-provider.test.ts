import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import type { ProviderId } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

const REMOVED = /OpenCode support removed; see the opencode branch/;

test("agents of a retired provider stay listed, read-only, and are never re-routed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "casm-retired-"));
  const store = new Store(join(home, "test.db"));
  const project = store.createProject({ name: "test", path: home });
  // As an older casm stored them.
  const old = store.createAgent({ projectId: project.id, name: "old opencode", provider: "opencode" as ProviderId, cwd: home, config: {} });
  store.updateAgent(old.id, { nativeSessionId: "ses_123" });
  store.saveProviderAvailability({ provider: "opencode" as ProviderId, updatedAt: new Date().toISOString(), windows: [{ id: "limit", label: "usage limit", status: "exhausted", resetsAt: new Date(Date.now() + 3600_000).toISOString() }] });
  let opened = 0;
  const provider: Provider = {
    id: "claude", history: async () => [], usage: async () => null, commands: async () => [], catalog: async () => ({ models: [], modes: [] }),
    open() {
      opened++;
      return { send() {}, shell() {}, async interrupt() {}, async close() {} };
    },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", home });
  const client = await CasmClient.connect(server.url, store.createToken("test"));
  t.after(async () => { client.close(); await server.close(); store.close(); await rm(home, { recursive: true, force: true }); });

  const listed = (await client.call("agent.list", {})).agents.find((a) => a.id === old.id);
  assert.equal(listed?.provider, "opencode");
  assert.match(listed?.unavailable ?? "", REMOVED);
  assert.match((await client.call("agent.get", { id: old.id })).unavailable ?? "", REMOVED);

  const history = await client.call("agent.history", { id: old.id });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].kind, "notice");
  assert.match((history.items[0] as { text: string }).text, REMOVED);

  await assert.rejects(client.call("agent.send", { id: old.id, text: "hello" }), REMOVED);
  await assert.rejects(client.call("agent.shell", { id: old.id, command: "ls" }), REMOVED);
  await assert.rejects(client.call("agent.mcpStatus", { id: old.id }), REMOVED);
  assert.equal((await client.call("agent.pending", { id: old.id })).messages.length, 0, "a refused send is not queued");
  assert.equal(opened, 0, "no other provider runs it");
  assert.deepEqual(await client.call("agent.usage", { id: old.id }), { usage: null });
  assert.deepEqual((await client.call("agent.commands", { id: old.id })).commands, []);
  assert.deepEqual((await client.call("provider.limits", {})).limits.map((l) => l.provider), []);
  await assert.rejects(client.call("agent.create", { projectId: project.id, provider: "opencode" as ProviderId, name: "new" }));

  // Still manageable: rename, archive, delete.
  assert.equal((await client.call("agent.update", { id: old.id, name: "renamed" })).name, "renamed");
  assert.equal((await client.call("agent.get", { id: old.id })).provider, "opencode");
  await client.call("agent.update", { id: old.id, archived: true });
  await client.call("agent.delete", { id: old.id });
  assert.equal((await client.call("agent.list", { includeArchived: true })).agents.some((a) => a.id === old.id), false);
});

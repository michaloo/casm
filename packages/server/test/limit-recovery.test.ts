import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

for (const recovery of ["send now", "healthy account refresh", "send now still limited"] as const) {
  test(`an idle limited recipient recovers through ${recovery} without losing queued work`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "casm-limit-recovery-"));
    const store = new Store(join(dir, "db"));
    const token = store.createToken("test");
    const delivered: string[] = [];
    let first = true;
    let rejectRetry = false;
    let healthy = false;
    let reportExhausted = false;
    const provider: Provider = {
      id: "codex",
      open(opts) {
        setImmediate(() => opts.emit({ type: "sessionId", id: "test-native" }));
        return {
          send(text) {
            delivered.push(text);
            setImmediate(() => {
              if (first || rejectRetry) {
                first = false;
                rejectRetry = false;
                opts.emit({ type: "turnEnded", outcome: "failed", error: "429 usage limit exceeded" });
              } else {
                opts.emit({ type: "item", item: { kind: "assistant", id: text, text } });
                opts.emit({ type: "turnEnded", outcome: "completed" });
              }
            });
          },
          shell() {}, async interrupt() {}, async close() {},
        };
      },
      async history() { return []; }, async usage() { return null; },
      async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
      async limits() { return healthy ? { windows: [{ id: "five_hour", status: "ok", usedPercent: 1 }] }
        : reportExhausted ? { windows: [{ id: "five_hour", status: "exhausted", usedPercent: 100 }] } : null; },
    };
    const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
    const client = await CasmClient.connect(server.url, token);
    try {
      const p = await client.call("project.create", { path: dir });
      const a = await client.call("agent.create", { projectId: p.id, provider: "codex" });
      await client.call("agent.send", { id: a.id, text: "original" });
      await client.call("agent.wait", { id: a.id });
      const before = await client.call("agent.get", { id: a.id });
      assert.equal(before.status, "idle");
      assert.ok(before.deferred);
      const queued = await client.call("agent.send", { id: a.id, text: "followup" });
      assert.equal(queued.queued, true);
      // An unavailable refresh must neither erase the synthetic limit nor run work.
      await client.call("provider.limits", { provider: "codex", refresh: true });
      assert.equal((await client.call("agent.pending", { id: a.id })).messages.length, 2);
      assert.deepEqual(delivered, ["original"]);
      reportExhausted = true;
      await client.call("provider.limits", { provider: "codex", refresh: true });
      assert.equal((await client.call("agent.pending", { id: a.id })).messages.length, 2);
      assert.deepEqual(delivered, ["original"]);
      reportExhausted = false;
      if (recovery !== "healthy account refresh") {
        rejectRetry = recovery === "send now still limited";
        assert.deepEqual(await client.call("agent.steerPending", { id: a.id, messageId: queued.pendingId! }), { queued: false });
      } else {
        healthy = true;
        const result = await client.call("provider.limits", { provider: "codex", refresh: true });
        assert.deepEqual(result.limits[0].windows.map((w) => w.id), ["five_hour"]);
      }
      await client.call("agent.wait", { id: a.id });
      await client.call("agent.wait", { id: a.id });
      if (recovery === "send now still limited") {
        assert.ok((await client.call("agent.get", { id: a.id })).deferred);
        const pending = (await client.call("agent.pending", { id: a.id })).messages;
        assert.deepEqual(pending.map((m) => m.text).sort(), ["followup", "original"]);
        healthy = true;
        await client.call("provider.limits", { provider: "codex", refresh: true });
        await client.call("agent.wait", { id: a.id });
        await client.call("agent.wait", { id: a.id });
      }
      const after = await client.call("agent.get", { id: a.id });
      assert.equal(after.deferred, null);
      assert.equal(after.pending?.count, 0);
      assert.deepEqual(delivered, recovery === "send now"
        ? ["original", "followup", "original"]
        : recovery === "send now still limited" ? ["original", "followup", "followup", "original"]
        : ["original", "original", "followup"]);
      assert.equal((await client.call("agent.send", { id: a.id, text: "normal again" })).queued, false);
      await client.call("agent.wait", { id: a.id });
    } finally {
      client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("empty account refresh preserves exhaustion for new recipients", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-empty-limits-"));
  const store = new Store(join(dir, "db"));
  const delivered: string[] = [];
  const provider: Provider = {
    id: "codex",
    open(opts) {
      return {
        send(text) {
          delivered.push(text);
          setImmediate(() => opts.emit({ type: "turnEnded", outcome: "failed", error: "429 usage limit exceeded" }));
        },
        shell() {}, async interrupt() {}, async close() {},
      };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
    async limits() { return { windows: [] }; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, store.createToken("test"));
  try {
    const p = await client.call("project.create", { path: dir });
    const a = await client.call("agent.create", { projectId: p.id, provider: "codex" });
    await client.call("agent.send", { id: a.id, text: "hits limit" });
    await client.call("agent.wait", { id: a.id });
    const fresh = await client.call("provider.limits", { provider: "codex", refresh: true });
    assert.equal(fresh.limits[0].windows[0]?.status, "exhausted");
    const b = await client.call("agent.create", { projectId: p.id, provider: "codex" });
    const sent = await client.call("agent.send", { id: b.id, text: "must wait" });
    assert.equal(sent.queued, true);
    assert.ok(sent.deferredUntil);
    assert.deepEqual(delivered, ["hits limit"]);
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("provider admission remains blocked across reopen for sibling agents and recovers durably", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-limit-restart-"));
  const file = join(dir, "db");
  let store = new Store(file);
  const project = store.createProject({ path: dir, name: "limits" });
  const a = store.createAgent({ projectId: project.id, provider: "codex", name: "a", cwd: dir, config: {} });
  const b = store.createAgent({ projectId: project.id, provider: "codex", name: "b", cwd: dir, config: {} });
  const token = store.createToken("test");
  const sent: string[] = [];
  let healthy = false;
  const provider: Provider = {
    id: "codex",
    open(opts) { return {
      send(text) {
        sent.push(text);
        setImmediate(() => opts.emit(healthy ? { type: "turnEnded", outcome: "completed" }
          : { type: "turnEnded", outcome: "failed", error: "usage limit reached; retry after 3600" }));
      },
      shell() {}, async interrupt() {}, async close() {},
    }; },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
    async limits() { return healthy ? { windows: [{ id: "account", status: "ok", usedPercent: 1 }] } : null; },
  };
  let server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  let client = await CasmClient.connect(server.url, token);
  const reopen = async () => {
    client.close(); await server.close(); store.close();
    store = new Store(file);
    server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
    client = await CasmClient.connect(server.url, token);
  };
  try {
    await client.call("agent.send", { id: a.id, text: "limited" });
    await client.call("agent.wait", { id: a.id });
    const until = store.providerAvailability()[0].windows[0].resetsAt;
    await reopen();
    assert.equal(store.providerAvailability()[0].windows[0].resetsAt, until);
    // Cancelling the triggering prompt must not erase the provider-wide gate.
    await client.call("agent.cancelPending", { id: a.id });
    assert.equal((await client.call("agent.send", { id: b.id, text: "sibling" })).queued, true);
    await client.call("provider.limits", { provider: "codex", refresh: true });
    assert.deepEqual(sent, ["limited"]);
    healthy = true;
    await client.call("provider.limits", { provider: "codex", refresh: true });
    await client.call("agent.wait", { id: b.id });
    assert.deepEqual(sent, ["limited", "sibling"]);
    await reopen();
    assert.equal((await client.call("agent.send", { id: b.id, text: "after recovery" })).queued, false);
    await client.call("agent.wait", { id: b.id });
    // An expired persisted window must not block admission on the next restart.
    store.saveProviderAvailability({ provider: "codex", updatedAt: new Date(0).toISOString(), windows: [{ id: "old", status: "exhausted", resetsAt: new Date(0).toISOString() }] });
    await reopen();
    assert.equal((await client.call("agent.send", { id: b.id, text: "expired" })).queued, false);
    await client.call("agent.wait", { id: b.id });
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy pending limits seed a provider gate once without overwriting recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-limit-upgrade-"));
  const store = new Store(join(dir, "db"));
  const p = store.createProject({ path: dir, name: "legacy" });
  const a = store.createAgent({ projectId: p.id, provider: "codex", name: "a", cwd: dir, config: {} });
  const b = store.createAgent({ projectId: p.id, provider: "codex", name: "b", cwd: dir, config: {} });
  const until = new Date(Date.now() + 3600_000).toISOString();
  store.addPending({ agentId: a.id, text: "legacy", reason: "limit", notBefore: until, note: "usage limit" });
  const provider: Provider = {
    id: "codex", open() { throw new Error("must remain queued"); },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  };
  let server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  try {
    assert.equal(store.providerAvailability()[0].windows[0].resetsAt, until);
    assert.equal(server.agents.send(b.id, { text: "sibling" }).queued, true);
    await server.close();
    store.saveProviderAvailability({ provider: "codex", updatedAt: new Date().toISOString(), windows: [{ id: "limit", status: "ok" }] });
    server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
    assert.equal(store.providerAvailability()[0].windows[0].status, "ok");
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

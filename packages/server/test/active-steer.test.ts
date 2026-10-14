import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

for (const scenario of ["global limit", "pending limit", "provider rejects steer"] as const) {
  test(`explicit active-turn steer reaches the session despite ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "casm-active-steer-"));
    const store = new Store(join(dir, "db"));
    const token = store.createToken("test");
    const delivered: string[] = [];
    let opens = 0;
    let interrupts = 0;
    let exhausted = false;
    const provider: Provider = {
      id: "codex",
      open(opts) {
        opens++;
        return {
          send(text) {
            delivered.push(text);
            if (text === "steer" && scenario === "provider rejects steer") setImmediate(() => {
              opts.emit({ type: "turnEnded", outcome: "failed", error: "429 usage limit exceeded" });
            });
          },
          shell() {}, async interrupt() { interrupts++; }, async close() {},
        };
      },
      async history() { return []; }, async usage() { return null; },
      async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
      async limits() { return exhausted ? { windows: [{ id: "five_hour", status: "exhausted", usedPercent: 100,
        resetsAt: new Date(Date.now() + 3600000).toISOString() }] } : null; },
    };
    const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
    const client = await CasmClient.connect(server.url, token);
    try {
      const project = await client.call("project.create", { path: dir });
      const active = await client.call("agent.create", { projectId: project.id, provider: "codex" });
      const idle = await client.call("agent.create", { projectId: project.id, provider: "codex" });
      await client.call("agent.send", { id: active.id, text: "original" });
      const before = await client.call("agent.subscribe", { id: active.id });
      if (scenario === "pending limit") {
        store.addPending({ agentId: active.id, text: "previously limited", reason: "limit",
          notBefore: new Date(Date.now() + 3600000).toISOString(), note: "previous limit" });
      } else {
        exhausted = true;
        await client.call("provider.limits", { provider: "codex", refresh: true });
        // Explicit steer on an idle agent still respects the account limit.
        assert.equal((await client.call("agent.send", { id: idle.id, text: "idle steer", whenBusy: "steer" })).queued, true);
        await assert.rejects(client.call("agent.send", { id: idle.id, text: "fail limited", whenBusy: "steer", whenLimited: "fail" }));
      }
      assert.equal((await client.call("agent.send", { id: active.id, text: "default queue" })).queued, true);
      assert.deepEqual(delivered, ["original"]);
      assert.deepEqual(await client.call("agent.send", {
        id: active.id, text: "steer", whenBusy: "steer", whenLimited: "fail",
      }), { queued: false });
      assert.deepEqual(delivered, ["original", "steer"]);
      assert.equal(opens, 1);
      assert.equal(interrupts, 0);
      if (scenario === "provider rejects steer") {
        await client.call("agent.wait", { id: active.id });
        const after = await client.call("agent.get", { id: active.id });
        assert.equal(after.status, "idle");
        assert.ok(after.deferred);
        const pending = (await client.call("agent.pending", { id: active.id })).messages;
        assert.ok(pending.some((message) => message.text === "steer"));
        assert.ok(pending.some((message) => message.text === "original" && message.reason === "limit"));
        assert.equal((await client.call("agent.send", { id: active.id, text: "after rejection", whenBusy: "steer" })).queued, true);
        assert.deepEqual(delivered, ["original", "steer"]);
      } else {
        assert.equal((await client.call("agent.get", { id: active.id })).status, "running");
        const after = await client.call("agent.subscribe", { id: active.id });
        assert.deepEqual(after.turn.filter((event) => event.type === "turnStarted"), before.turn.filter((event) => event.type === "turnStarted"));
        assert.ok(!(await client.call("agent.pending", { id: active.id })).messages.some((message) => message.text === "steer"));
      }
    } finally {
      client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}

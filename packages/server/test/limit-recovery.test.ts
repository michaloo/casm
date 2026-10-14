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

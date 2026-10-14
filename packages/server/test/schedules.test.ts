import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { nextRun } from "../src/schedules.ts";
import type { Provider } from "../src/providers/types.ts";

test("an interval counts from when the run was due, not from the late tick that fired it", () => {
  const every = { type: "every", minutes: 1 } as const;
  const due = new Date("2026-10-14T21:00:00Z");
  const late = new Date("2026-10-14T21:00:11Z");
  assert.equal(nextRun(every, late, true, due)?.toISOString(), "2026-10-14T21:01:00.000Z");
  // A long gap (the server was down) runs once and counts on from now.
  const afterGap = new Date("2026-10-14T21:45:30Z");
  assert.equal(nextRun(every, afterGap, true, due)?.toISOString(), "2026-10-14T21:46:30.000Z");
  assert.equal(nextRun(every, late)?.toISOString(), "2026-10-14T21:01:11.000Z");
});

test("a schedule firing at a limited agent leaves a pending message with its sender; edit, disable and enable apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-sched-limit-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const delivered: string[] = [];
  let limited = true;
  const provider: Provider = {
    id: "codex",
    open(opts) {
      setImmediate(() => opts.emit({ type: "sessionId", id: "native" }));
      return {
        send(text) {
          delivered.push(text);
          setImmediate(() => {
            if (limited) opts.emit({ type: "turnEnded", outcome: "failed", error: "429 usage limit exceeded" });
            else {
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
    async limits() { return null; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const p = await client.call("project.create", { path: dir });
    const a = await client.call("agent.create", { projectId: p.id, provider: "codex" });
    await client.call("agent.send", { id: a.id, text: "trip the limit" });
    await client.call("agent.wait", { id: a.id });
    assert.ok((await client.call("agent.get", { id: a.id })).deferred);

    const s = await client.call("schedule.create", { name: "digest", cadence: { type: "every", minutes: 10 }, target: { type: "agent", agentId: a.id }, prompt: "daily digest" });
    const run = await client.call("schedule.runNow", { id: s.id });
    assert.equal(run.outcome, "queued");
    const [held, mine] = (await client.call("agent.pending", { id: a.id })).messages.sort((x, y) => (x.text === "daily digest" ? 1 : -1) - (y.text === "daily digest" ? 1 : -1));
    assert.equal(held.reason, "limit");
    assert.equal(mine.text, "daily digest");
    assert.deepEqual(mine.sender?.schedule, { id: s.id, name: "digest" });
    assert.deepEqual(delivered, ["trip the limit"]);

    // Edit changes the prompt and the cadence; disable clears the next run and enable restores it.
    const edited = await client.call("schedule.update", { id: s.id, prompt: "weekly digest", cadence: { type: "every", minutes: 60 } });
    assert.equal(edited.prompt, "weekly digest");
    assert.ok(Date.parse(edited.nextRunAt!) > Date.now() + 59 * 60_000);
    assert.equal((await client.call("schedule.update", { id: s.id, enabled: false })).nextRunAt, null);
    await server.scheduler.tick(new Date(Date.now() + 2 * 3600_000));
    assert.equal((await client.call("agent.pending", { id: a.id })).messages.length, 2);
    assert.ok((await client.call("schedule.update", { id: s.id, enabled: true })).nextRunAt);

    // Once the limit lifts, the held message and then the scheduled one go in order.
    limited = false;
    await client.call("agent.retryPending", { id: a.id, messageId: held.id });
    for (let i = 0; i < 100 && delivered.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(delivered, ["trip the limit", "trip the limit", "daily digest"]);
    await client.call("schedule.delete", { id: s.id });
    assert.deepEqual((await client.call("schedule.list", {})).schedules, []);
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

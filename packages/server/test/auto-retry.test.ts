// Automatic retry of turns that failed for transient reasons, on fake timers.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { AgentManager } from "../src/agents.ts";
import { classifyFailure } from "../src/failures.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

const T0 = Date.parse("2026-10-18T20:00:00Z");
const SEC = 1000;
const MIN = 60 * SEC;

function setup() {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
  const dir = mkdtempSync(join(tmpdir(), "casm-retry-"));
  const store = new Store(join(dir, "db"));
  const project = store.createProject({ name: "P", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "codex", cwd: dir, config: {} });
  const sent: { text: string; id: string }[] = [];
  const sessions: OpenOptions[] = [];
  const provider: Provider = {
    id: "codex",
    open(opts) {
      sessions.push(opts);
      return { send(text, id) { sent.push({ text, id }); }, shell() {}, async interrupt() {}, async close() {} };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  };
  const manager = () => new AgentManager(store, new Map([["codex", provider]]), () => {});
  const t = {
    store, sent, id: agent.id, agents: manager(),
    restart: async () => {
      await t.agents.shutdown();
      t.agents = manager();
      // What the server does at startup.
      const checked = t.agents.dropAnsweredFailed();
      t.agents.runDuePending();
      await checked;
    },
    fail: (error: string) => sessions.at(-1)!.emit({ type: "turnEnded", outcome: "failed", error }),
    finish: () => sessions.at(-1)!.emit({ type: "turnEnded", outcome: "completed" }),
    pending: () => t.agents.pendingMessages(agent.id),
    // Advances time in steps, so timers armed along the way fire too.
    wait: (ms: number) => { for (let left = ms; left > 0; left -= SEC) mock.timers.tick(Math.min(SEC, left)); },
    async done() {
      await t.agents.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
      mock.timers.reset();
    },
  };
  return t;
}

test("failures are classified as transient or permanent", () => {
  assert.equal(classifyFailure("stopped", "anything"), "transient");
  assert.equal(classifyFailure("process", "agent process exited"), "transient");
  assert.equal(classifyFailure("process", "Claude Code process exited with code 1"), "transient");
  assert.equal(classifyFailure("dispatch", "spawn codex ENOENT"), "transient");
  assert.equal(classifyFailure("provider", "API Error: 529 {\"type\":\"overloaded_error\"}"), "transient");
  assert.equal(classifyFailure("provider", "API Error: 500 Internal server error"), "transient");
  assert.equal(classifyFailure("provider", "fetch failed: ECONNRESET"), "transient");
  assert.equal(classifyFailure("provider", "Invalid API key · Please run /login"), "permanent");
  assert.equal(classifyFailure("provider", "API Error: 401 authentication_error"), "permanent");
  assert.equal(classifyFailure("provider", "model gpt-9 does not exist"), "permanent");
  assert.equal(classifyFailure("provider", "No conversation found with session ID: x"), "permanent");
  // An error we don't recognise from the provider itself holds, as before.
  assert.equal(classifyFailure("provider", "something odd"), "permanent");
  // A process that exits saying why it can't work isn't retried either.
  assert.equal(classifyFailure("process", "Not logged in · Please run /login"), "permanent");
});

test("a turn cut short by a server stop is retried right after startup, under the same message id", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "hourly report" });
    await t.restart();
    // Retried at once (the startup check found no answer), as the first attempt.
    assert.deepEqual(t.sent.map((s) => s.text), ["hourly report", "hourly report"]);
    assert.deepEqual(t.pending(), []);
    t.fail("agent process exited");
    const [m] = t.pending();
    assert.equal(m.text, "hourly report");
    assert.deepEqual(m.retry, { attempt: 2, of: 3 });
    assert.equal(m.notBefore, new Date(Date.now() + 2 * MIN).toISOString());
    // Another stop doesn't count against the message, and it keeps its id.
    t.wait(2 * MIN);
    assert.equal(t.sent.length, 3);
    await t.restart();
    assert.equal(t.sent.length, 4);
    // Each attempt reaches the agent under a fresh item id.
    assert.equal(new Set(t.sent.map((s) => s.id)).size, 4);
    assert.ok(!t.sent.some((s) => s.id === m.id));
    t.fail("agent process exited");
    assert.deepEqual(t.pending().map((x) => [x.id, x.retry?.attempt]), [[m.id, 3]]);
  } finally {
    await t.done();
  }
});

test("a transient failure backs off 30 s, 2 min, 10 min, then holds the queue", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "x" });
    const steps = [30 * SEC, 2 * MIN, 10 * MIN];
    for (const [i, delay] of steps.entries()) {
      t.fail("API Error: 529 overloaded");
      const [m] = t.pending();
      assert.equal(m.reason, "failed");
      assert.deepEqual(m.retry, { attempt: i + 1, of: 3 });
      assert.equal(m.notBefore, new Date(Date.now() + delay).toISOString());
      assert.equal(t.agents.withStatus(t.store.getAgent(t.id)!).pending?.held?.retryAt, m.notBefore);
      t.wait(delay - SEC);
      assert.equal(t.sent.length, i + 1);
      t.wait(SEC);
      assert.equal(t.sent.length, i + 2);
    }
    t.fail("API Error: 529 overloaded");
    const [held] = t.pending();
    assert.equal(held.reason, "failed");
    assert.equal(held.retry, undefined);
    assert.equal(held.notBefore, undefined);
    assert.match(held.note!, /overloaded \(gave up after 3 automatic retries\)/);
    t.wait(30 * MIN);
    t.agents.runDuePending();
    assert.equal(t.sent.length, 4);
  } finally {
    await t.done();
  }
});

test("a permanent failure holds the queue without retrying", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "x" });
    t.fail("Invalid API key · Please run /login");
    const [m] = t.pending();
    assert.deepEqual([m.reason, m.notBefore, m.retry], ["failed", undefined, undefined]);
    assert.deepEqual(t.agents.withStatus(t.store.getAgent(t.id)!).pending?.held, { reason: "failed", note: "Invalid API key · Please run /login" });
    t.wait(30 * MIN);
    t.agents.runDuePending();
    assert.equal(t.sent.length, 1);
  } finally {
    await t.done();
  }
});

test("Retry now and Cancel work during a backoff", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "x" });
    t.fail("socket hang up");
    const [m] = t.pending();
    // Retry now makes the scheduled attempt at once.
    t.agents.retryPending(t.id, m.id);
    assert.equal(t.sent.length, 2);
    assert.deepEqual(t.pending(), []);
    t.fail("socket hang up");
    const [again] = t.pending();
    assert.deepEqual([again.id, again.retry], [m.id, { attempt: 2, of: 3 }]);
    // Cancel drops it and its timer.
    assert.equal(t.agents.cancelPending(t.id, m.id), 1);
    t.wait(15 * MIN);
    assert.equal(t.sent.length, 2);
    assert.deepEqual(t.pending(), []);
  } finally {
    await t.done();
  }
});

test("later messages wait behind a retrying head, in order", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "first" });
    t.agents.send(t.id, { text: "second" });
    t.fail("agent process exited");
    // The head holds the queue while it waits, and new sends queue behind it.
    t.agents.send(t.id, { text: "third" });
    assert.deepEqual(t.pending().map((m) => [m.text, m.reason]), [["first", "failed"], ["second", "queued"], ["third", "queued"]]);
    assert.deepEqual(t.sent.map((s) => s.text), ["first"]);
    t.wait(30 * SEC);
    assert.deepEqual(t.sent.map((s) => s.text), ["first", "first"]);
    t.finish();
    t.finish();
    t.finish();
    assert.deepEqual(t.sent.map((s) => s.text), ["first", "first", "second", "third"]);
    assert.deepEqual(t.pending(), []);
  } finally {
    await t.done();
  }
});

test("retry counters and times survive a restart", async () => {
  const t = setup();
  try {
    t.agents.send(t.id, { text: "x" });
    t.fail("API Error: 503 Service Unavailable");
    t.wait(30 * SEC);
    t.fail("API Error: 503 Service Unavailable");
    const [m] = t.pending();
    assert.deepEqual(m.retry, { attempt: 2, of: 3 });
    t.wait(MIN);
    await t.restart();
    // Not due yet: still waiting, same attempt and time.
    assert.deepEqual(t.pending(), [m]);
    assert.equal(t.sent.length, 2);
    t.wait(MIN);
    assert.equal(t.sent.length, 3);
    t.fail("API Error: 503 Service Unavailable");
    assert.deepEqual(t.pending().map((x) => [x.id, x.retry?.attempt]), [[m.id, 3]]);
  } finally {
    await t.done();
  }
});

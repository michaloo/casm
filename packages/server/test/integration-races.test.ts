import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Answers, Command, MessageSender } from "@casm/protocol";
import { AgentManager } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

const sender: MessageSender = { serverId: "peer-server", agentId: "peer-agent", name: "Review agent", host: "peer" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// No native processes, sockets, timers for acceptance, or filesystem databases.
// Explicit deferred Promises model the gap between dispatch and acceptance.
function fixture(t: TestContext, commands: () => Promise<Command[]> = async () => []) {
  const store = new Store(":memory:");
  const project = store.createProject({ name: "integration races", path: process.cwd() });
  const agent = store.createAgent({ projectId: project.id, name: "target", provider: "codex", cwd: process.cwd(), config: {} });
  let opts: OpenOptions;
  let stopped = false;
  let closed = false;
  const sent: { id: string; text: string }[] = [];
  const sends = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let answer: (answers: Answers | null) => Promise<void> = async () => {};
  const provider: Provider = {
    id: "codex", commands,
    async catalog() { return { models: [], modes: [] }; },
    async history() { return []; },
    async usage() { return null; },
    open(o) {
      opts = o;
      o.emit({ type: "sessionId", id: "native" });
      return {
        send(text, id) { sent.push({ id, text }); return sends.get(id)?.promise; },
        shell() {},
        async interrupt() {},
        async close() {},
        answerAsyncQuestion(_id, answers) { return answer(answers); },
      };
    },
  };
  const manager = new AgentManager(store, new Map([["codex", provider]]), () => {});
  const stop = async () => { if (!stopped) { stopped = true; await manager.shutdown(); } };
  const close = () => { if (!closed) { closed = true; store.close(); } };
  t.after(async () => { await stop(); close(); });
  manager.send(agent.id, { id: "original", text: "original" });
  return {
    store, manager, agent, sent, stop, close,
    get opts() { return opts; },
    hold(id: string) { const gate = Promise.withResolvers<void>(); sends.set(id, gate); return gate; },
    fail(id: string) {
      opts.emit({ type: "sendFailed", itemId: id, error: `Rejected ${id}` });
      sends.get(id)!.resolve();
    },
    end() { opts.emit({ type: "turnEnded", outcome: "completed" }); },
    question(submit: typeof answer) {
      answer = submit;
      opts.emit({ type: "asyncQuestion", request: { id: "question", nonBlocking: true,
        prompts: [{ id: "choice", text: "Which environment?", kind: "text" }] } });
    },
  };
}

test("integration: a queued message cannot overtake a steer that rejects after turn end", async t => {
  const f = fixture(t);
  f.hold("steer-a");
  f.manager.send(f.agent.id, { id: "steer-a", text: "A", sender }, "steer");
  const queued = f.manager.send(f.agent.id, { id: "queued-b", text: "B", sender });
  assert.equal(queued.pendingId, "queued-b");
  f.end();
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
  assert.equal(f.store.getPending("queued-b")?.id, "queued-b");
  f.fail("steer-a");
  await flush();
  const pending = f.store.listPending(f.agent.id);
  assert.deepEqual(pending.map(p => [p.text, p.reason]), [["A", "failed"], ["B", "queued"]]);
  assert.deepEqual(pending.map(p => p.sender), [sender, sender]);
  assert.equal(pending[1].id, "queued-b");
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
  // Cancelling the failed head releases the original queued ID and provenance.
  f.manager.cancelPending(f.agent.id, pending[0].id);
  await flush();
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a", "queued-b"]);
  assert.deepEqual(f.store.messageSender(f.agent.id, "queued-b"), sender);
});

test("integration: direct send after turn end waits for pending steer acceptance and then drains", async t => {
  const f = fixture(t);
  const acceptance = f.hold("steer-a");
  f.manager.send(f.agent.id, { id: "steer-a", text: "A", sender }, "steer");
  f.end();
  const direct = f.manager.send(f.agent.id, { id: "direct-b", text: "B", sender });
  assert.equal(direct.queued, true);
  assert.equal(direct.pendingId, "direct-b");
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
  assert.deepEqual(f.store.getPending("direct-b")?.sender, sender);
  acceptance.resolve();
  await flush();
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a", "direct-b"]);
  assert.equal(f.store.getPending("direct-b"), undefined);
  assert.deepEqual(f.store.messageSender(f.agent.id, "direct-b"), sender);
});

test("integration: successive steer failures retain dispatch order and queued message identity", async t => {
  const f = fixture(t);
  for (const [id, text] of [["steer-a", "A"], ["steer-b", "B"]]) {
    f.hold(id);
    f.manager.send(f.agent.id, { id, text, sender }, "steer");
  }
  f.manager.send(f.agent.id, { id: "queued-c", text: "C", sender });
  f.fail("steer-a");
  await flush();
  const firstFailedId = f.store.listPending(f.agent.id)[0].id;
  f.fail("steer-b");
  await flush();
  const pending = f.store.listPending(f.agent.id);
  assert.deepEqual(pending.map(p => [p.text, p.reason]), [["A", "failed"], ["B", "failed"], ["C", "queued"]]);
  assert.equal(pending[0].id, firstFailedId);
  assert.equal(pending[2].id, "queued-c");
  assert.deepEqual(pending.map(p => p.sender), [sender, sender, sender]);
  f.end();
  await flush();
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a", "steer-b"]);
  assert.deepEqual(f.store.listPending(f.agent.id).map(p => p.id), pending.map(p => p.id));
});

test("integration: out-of-order B then A rejection retains A/B order and existing pending IDs", async t => {
  const f = fixture(t);
  for (const [id, text] of [["steer-a", "A"], ["steer-b", "B"]]) {
    f.hold(id);
    f.manager.send(f.agent.id, { id, text, sender }, "steer");
  }
  f.manager.send(f.agent.id, { id: "queued-c", text: "C", sender });
  f.fail("steer-b");
  await flush();
  const bId = f.store.listPending(f.agent.id).find(p => p.text === "B")!.id;
  f.fail("steer-a");
  await flush();
  const pending = f.store.listPending(f.agent.id);
  assert.deepEqual(pending.map(p => [p.text, p.reason]), [["A", "failed"], ["B", "failed"], ["C", "queued"]]);
  assert.equal(pending[1].id, bId);
  assert.equal(pending[2].id, "queued-c");
  assert.deepEqual(pending.map(p => p.sender), [sender, sender, sender]);
  f.end();
  await flush();
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a", "steer-b"]);
});

test("integration: failed turn then late steer rejections retain initial/A/B once in dispatch order", async t => {
  const f = fixture(t);
  for (const [id, text] of [["steer-a", "A"], ["steer-b", "B"]]) {
    f.hold(id);
    f.manager.send(f.agent.id, { id, text, sender }, "steer");
  }
  f.manager.send(f.agent.id, { id: "queued-c", text: "C", sender });
  f.opts.emit({ type: "turnEnded", outcome: "failed", error: "original turn failed" });
  const before = f.store.listPending(f.agent.id);
  assert.deepEqual(before.map(p => [p.text, p.reason]), [["original", "failed"], ["A", "failed"], ["B", "failed"], ["C", "queued"]]);
  f.fail("steer-b");
  await flush();
  f.fail("steer-a");
  await flush();
  const after = f.store.listPending(f.agent.id);
  assert.deepEqual(after.map(p => [p.id, p.text, p.reason, p.sender]), before.map(p => [p.id, p.text, p.reason, p.sender]));
  assert.equal(new Set(after.map(p => p.id)).size, 4);
  assert.equal(after[3].id, "queued-c");
  assert.deepEqual(after.slice(1).map(p => p.sender), [sender, sender, sender]);
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a", "steer-b"]);
});

test("integration: automatic retries wait for late steer acceptance and preserve retry IDs and backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-19T12:00:00Z") });
  const f = fixture(t);
  for (const [id, text] of [["steer-a", "A"], ["steer-b", "B"]]) {
    f.hold(id);
    f.manager.send(f.agent.id, { id, text, sender }, "steer");
  }
  f.manager.send(f.agent.id, { id: "queued-c", text: "C", sender });
  f.opts.emit({ type: "turnEnded", outcome: "failed", error: "API Error: 503 Service Unavailable" });
  const before = f.store.listPending(f.agent.id);
  assert.deepEqual(before.map(p => p.text), ["original", "A", "B", "C"]);
  assert.ok(before.slice(0, 3).every(p => p.notBefore === new Date(Date.now() + 30_000).toISOString()));
  t.mock.timers.tick(30_000);
  assert.equal(f.sent.length, 3, "the retry is due but two steers still await acceptance");
  f.fail("steer-b");
  await flush();
  assert.equal(f.sent.length, 3);
  f.fail("steer-a");
  await flush();
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[3].text, "original");
  assert.ok(!["original", before[0].id].includes(f.sent[3].id));
  f.opts.emit({ type: "turnEnded", outcome: "failed", error: "API Error: 503 Service Unavailable" });
  const after = f.store.listPending(f.agent.id);
  assert.deepEqual(after.map(p => [p.id, p.text, p.sender]), before.map(p => [p.id, p.text, p.sender]));
  assert.deepEqual(after.map(p => p.attempts), [1, 0, 0, 0]);
  assert.equal(after[0].notBefore, new Date(Date.now() + 120_000).toISOString());
  assert.deepEqual(after.slice(1).map(p => [p.notBefore, p.attempts, p.note]), before.slice(1).map(p => [p.notBefore, p.attempts, p.note]), "late steer failures retain the original retry policy");
});

test("integration: shutdown retains unanswered and unsettled prompts once with startup retry policy", async t => {
  const f = fixture(t);
  f.hold("steer-a");
  f.manager.send(f.agent.id, { id: "steer-a", text: "A", sender }, "steer");
  f.manager.send(f.agent.id, { id: "queued-b", text: "B", sender });
  await f.stop();
  const before = f.store.listPending(f.agent.id);
  assert.deepEqual(before.map(p => [p.text, p.reason, p.attempts]), [["original", "failed", 0], ["A", "failed", 0], ["B", "queued", 0]]);
  assert.ok(before.slice(0, 2).every(p => p.notBefore && Date.parse(p.notBefore) <= Date.now()));
  assert.equal(before[2].id, "queued-b");
  assert.deepEqual(before.slice(1).map(p => p.sender), [sender, sender]);
  f.fail("steer-a");
  await flush();
  assert.deepEqual(f.store.listPending(f.agent.id), before);
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
});

test("integration: provider closure after turn end retains unresolved steer once and releases running status", async t => {
  const f = fixture(t);
  f.hold("steer-a");
  f.manager.send(f.agent.id, { id: "steer-a", text: "A", sender }, "steer");
  f.manager.send(f.agent.id, { id: "queued-b", text: "B", sender });
  f.end();
  assert.equal(f.manager.status(f.agent.id), "running");
  f.opts.emit({ type: "closed", error: "provider exited before acknowledgment" });
  const before = f.store.listPending(f.agent.id);
  assert.deepEqual(before.map(p => [p.text, p.reason]), [["A", "failed"], ["B", "queued"]]);
  assert.equal(before[1].id, "queued-b");
  assert.deepEqual(before.map(p => p.sender), [sender, sender]);
  assert.equal(f.manager.status(f.agent.id), "idle");
  assert.equal(f.manager.runningCount(), 0);
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
  // The old generation's callback is ignored; settling its Promise is harmless.
  f.fail("steer-a");
  await flush();
  const after = f.store.listPending(f.agent.id);
  assert.deepEqual(after.map(p => [p.id, p.text, p.reason, p.sender]), before.map(p => [p.id, p.text, p.reason, p.sender]));
  assert.equal(f.manager.status(f.agent.id), "idle");
  assert.equal(f.manager.runningCount(), 0);
  assert.deepEqual(f.sent.map(s => s.id), ["original", "steer-a"]);
});

for (const outcome of ["accepted", "rejected"] as const) {
  test(`integration: ${outcome} async answer settling after shutdown never accesses the closed store`, async t => {
    const f = fixture(t);
    const delivery = Promise.withResolvers<void>();
    f.question(() => delivery.promise);
    const result = f.manager.answerQuestion(f.agent.id, "question", { choice: "Staging" })
      .then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await f.stop();
    f.close();
    if (outcome === "accepted") delivery.resolve();
    else delivery.reject(new Error("native answer rejected"));
    const settled = await result;
    assert.ok(settled.error instanceof Error);
    assert.equal(settled.error.message, outcome === "accepted"
      ? "server stopped before the answer outcome could be recorded"
      : "native answer rejected");
    assert.doesNotMatch(settled.error.message, /database is not open/);
  });
}

test("integration: rejection of invalidated command lookup cannot evict its successful replacement", async t => {
  const oldLookup = Promise.withResolvers<Command[]>();
  let calls = 0;
  const fresh: Command[] = [{ name: "fresh", kind: "command", description: "Updated commands" }];
  const f = fixture(t, () => ++calls === 1 ? oldLookup.promise : Promise.resolve(fresh));
  // openSession warmed the first lookup; this call shares that pending work.
  const stale = f.manager.commands(f.agent.id).then(() => undefined, () => undefined);
  await flush();
  assert.equal(calls, 1);
  f.opts.emit({ type: "commandsChanged" });
  assert.deepEqual(await f.manager.commands(f.agent.id), fresh);
  assert.equal(calls, 2);
  oldLookup.reject(new Error("old lookup failed"));
  await stale;
  assert.deepEqual(await f.manager.commands(f.agent.id), fresh);
  assert.equal(calls, 2, "the old rejection must not delete the replacement cache entry");
});

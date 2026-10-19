import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { AgentManager } from "../src/agents.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";
import { asyncQuestions } from "../src/providers/codex.ts";

function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "casm-questions-manager-"));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "test", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "codex", cwd: dir, config: {} });
  const other = store.createAgent({ projectId: project.id, name: "b", provider: "codex", cwd: dir, config: {} });
  let opts: OpenOptions;
  let submit = async (_id: string, _answers: unknown) => {};
  const provider: Provider = { id: "codex", async history() { return []; }, async catalog() { return { models: [], modes: [] }; }, async commands() { return []; }, async usage() { return null; },
    open(o) { opts = o; o.emit({ type: "sessionId", id: "native" }); return { send() {}, shell() {}, async interrupt() {}, async close() {}, answerAsyncQuestion: (id, answers) => submit(id, answers) }; },
  };
  const manager = new AgentManager(store, new Map([["codex", provider]]), () => {});
  manager.send(agent.id, { text: "test" });
  const requests = asyncQuestions({ type: "agentMessage", id: "item", questions: [{ title: "First?" }, { title: "Second?" }] });
  const publish = () => requests.forEach(request => opts.emit({ type: "asyncQuestion", request }));
  const end = () => opts.emit({ type: "turnEnded", outcome: "completed" });
  t.after(async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, store, agent, other, requests, publish, end, setSubmit(fn: typeof submit) { submit = fn; }, get opts() { return opts; } };
}

test("async questions stay running, survive subscribe reload and resolve independently with durable outcomes", async t => {
  const f = fixture(t); f.publish(); f.publish();
  assert.equal(f.manager.status(f.agent.id), "running");
  assert.deepEqual(f.manager.blocked(), []);
  assert.equal(f.manager.subscribeState(f.agent.id).questions.length, 2);
  assert.deepEqual(f.manager.subscribeState(f.other.id).questions, []);
  await assert.rejects(f.manager.answerQuestion(f.other.id, f.requests[0].id, {}), /no such/);
  await f.manager.answerQuestion(f.agent.id, f.requests[0].id, { [f.requests[0].id]: "answer" });
  assert.equal(f.manager.subscribeState(f.agent.id).questions.length, 1);
  await f.manager.answerQuestion(f.agent.id, f.requests[1].id, null);
  assert.equal(f.manager.status(f.agent.id), "running");
  const history = await f.manager.history(f.agent.id);
  assert.equal(history.items.length, 2);
  assert.match(JSON.stringify(history.items), /Answer accepted/);
  assert.match(JSON.stringify(history.items), /Dismissed without/);
  await assert.rejects(f.manager.answerQuestion(f.agent.id, f.requests[0].id, {}), /no such/);
});

test("rejected or concurrent answers retain editor; turn-end expires questions and late answers", async t => {
  const f = fixture(t); f.publish();
  f.setSubmit(async () => { throw Error("provider rejected"); });
  await assert.rejects(f.manager.answerQuestion(f.agent.id, f.requests[0].id, {}), /provider rejected/);
  assert.equal(f.manager.subscribeState(f.agent.id).questions.length, 2);
  assert.equal(f.manager.status(f.agent.id), "running");
  const delivery = Promise.withResolvers<void>();
  f.setSubmit(() => delivery.promise);
  const pending = f.manager.answerQuestion(f.agent.id, f.requests[0].id, {});
  await assert.rejects(f.manager.answerQuestion(f.agent.id, f.requests[0].id, {}), /in progress/);
  f.end();
  assert.equal(f.manager.subscribeState(f.agent.id).questions.length, 0);
  delivery.resolve(); await pending;
  assert.match(JSON.stringify(await f.manager.history(f.agent.id)), /Answer accepted/);
  await assert.rejects(f.manager.answerQuestion(f.agent.id, f.requests[1].id, {}), /no such/);
  assert.equal(f.manager.status(f.agent.id), "idle");
});

test("blocking questions retain waiting behavior alongside async questions", async t => {
  const f = fixture(t); f.publish();
  const controller = new AbortController();
  const blocking = f.opts.askQuestion({ id: "blocking", prompts: [{ id: "q", text: "Blocking?", kind: "text" }] }, controller.signal);
  assert.equal(f.manager.status(f.agent.id), "waiting");
  assert.deepEqual(f.manager.blocked(), [{ agentId: f.agent.id, permissions: 0, questions: 1 }]);
  await f.manager.answerQuestion(f.agent.id, "blocking", { q: "yes" });
  assert.deepEqual(await blocking, { q: "yes" });
  assert.equal(f.manager.status(f.agent.id), "running");
  assert.equal(f.manager.subscribeState(f.agent.id).questions.length, 2);
});

test("restart expires old-session editors while preserving their history", async t => {
  const f = fixture(t); f.publish(); f.end();
  await f.manager.restart(f.agent.id);
  assert.deepEqual(f.manager.subscribeState(f.agent.id).questions, []);
  await assert.rejects(f.manager.answerQuestion(f.agent.id, f.requests[0].id, {}), /no such/);
  assert.match(JSON.stringify(await f.manager.history(f.agent.id)), /Answer window closed/);
});

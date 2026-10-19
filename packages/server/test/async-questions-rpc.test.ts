import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { AgentManager } from "../src/agents.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

// Real CASM RPC transport; fake provider controls acceptance independently of delivery.
test("async answer RPC awaits native acceptance, retains rejected questions, and reload does not revive resolved editors", { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "casm-async-rpc-"));
  let store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "test", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "codex", cwd: dir, config: {} });
  const gate = Promise.withResolvers<void>();
  let opts: OpenOptions;
  let fail = true;
  const provider: Provider = { id: "codex", async catalog() { return { models: [], modes: [] }; }, async commands() { return []; }, async usage() { return null; },
    async history() { return [{ kind: "assistant", id: "question-text", text: "Which environment?\n- Staging\n- Production" }]; },
    open(o) { opts = o; o.emit({ type: "sessionId", id: "native" }); return {
      send() { o.emit({ type: "asyncQuestion", request: { id: "question", nonBlocking: true, prompts: [{ id: "environment", kind: "text", text: "Which environment?" }] } }); },
      async answerAsyncQuestion() { if (fail) throw Error("native rejected answer"); await gate.promise; },
      shell() {}, async interrupt() { throw Error("must not interrupt"); }, async close() {},
    }; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, store.createToken("test"));
  let closed = false;
  t.after(async () => { client.close(); if (!closed) await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await client.call("agent.send", { id: agent.id, text: "test" });
  const state = await client.call("agent.subscribe", { id: agent.id });
  assert.equal(state.status, "running");
  assert.equal(state.questions[0].nonBlocking, true);
  await assert.rejects(client.call("agent.answerQuestion", { id: agent.id, requestId: "question", answers: { environment: "Staging" } }), /native rejected/);
  assert.equal((await client.call("agent.subscribe", { id: agent.id })).questions.length, 1);
  fail = false;
  let accepted = false;
  const reply = client.call("agent.answerQuestion", { id: agent.id, requestId: "question", answers: { environment: "Staging" } }).then(() => { accepted = true; });
  // Same connection orders this subscribe after the answer request has started.
  assert.equal((await client.call("agent.subscribe", { id: agent.id })).questions.length, 1);
  assert.equal(accepted, false);
  gate.resolve(); await reply;
  assert.equal((await client.call("agent.subscribe", { id: agent.id })).questions.length, 0);
  assert.equal((await client.call("agent.subscribe", { id: agent.id })).status, "running");
  opts!.emit({ type: "turnEnded", outcome: "completed" });
  client.close(); await server.close(); closed = true;
  store.close(); store = new Store(join(dir, "state.db"));
  const reloaded = new AgentManager(store, new Map([["codex", provider]]), () => {});
  assert.equal(reloaded.subscribeState(agent.id).questions.length, 0);
  const history = await reloaded.history(agent.id);
  assert.match(JSON.stringify(history), /Which environment/);
  assert.match(JSON.stringify(history), /Answer accepted/);
  await assert.rejects(reloaded.answerQuestion(agent.id, "question", {}), /no such/);
  await reloaded.shutdown();
});

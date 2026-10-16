// Turns a provider starts on its own while idle (a background job reporting
// back): each provider adopts them, and the manager runs them as turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { piProvider } from "../src/providers/pi.ts";
import type { OpenOptions, Provider, ProviderEvent } from "../src/providers/types.ts";

// A fake provider binary: on the first prompt it writes `turn`, then `wake`
// a moment later, as if a background job had finished. Messages are JSON
// lines; Codex's first answers its request id.
type Fixture = { variable: string; prompt: string; turn: unknown[]; wake: unknown[] };
let lastEvents: ProviderEvent[] = [];

const claude = (ownWake: unknown[]): Fixture => {
  const session = "session";
  const state = (s: string) => ({ type: "system", subtype: "session_state_changed", state: s, uuid: `state-${Math.random()}`, session_id: session });
  const init = () => ({ type: "system", subtype: "init", session_id: session, uuid: `init-${Math.random()}` });
  const result = (uuid: string, text: string) => ({ type: "result", subtype: "success", uuid, session_id: session, is_error: false, result: text, total_cost_usd: 0, modelUsage: {} });
  return {
    variable: "CASM_CLAUDE_PATH", prompt: "user",
    turn: [state("running"), init(), assistant("a1", "waiting"), result("r1", "waiting"), state("idle")],
    wake: [...ownWake, assistant("a2", "finished"), result("r2", "finished"), state("idle")],
  };
  function assistant(uuid: string, text: string) {
    return { type: "assistant", uuid, session_id: session, parent_tool_use_id: null, message: { id: uuid, role: "assistant", content: [{ type: "text", text }] } };
  }
};
const notification = { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "toolu_bg", status: "completed", output_file: "/tmp/b1.output", summary: 'Background command "sleep 20" completed (exit code 0)', uuid: "n1", session_id: "session" };
const state = (s: string) => ({ type: "system", subtype: "session_state_changed", state: s, uuid: `s-${s}-${Math.random()}`, session_id: "session" });
const init = { type: "system", subtype: "init", session_id: "session", uuid: "init-2" };

async function drive(kind: "claude" | "codex" | "pi", fixture: Fixture) {
  const dir = mkdtempSync(join(tmpdir(), "casm-wake-"));
  const binary = join(dir, "fake.cjs");
  writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const turn = ${JSON.stringify(fixture.turn)}, wake = ${JSON.stringify(fixture.wake)};
let started = false;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') return write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if (m.type === 'get_state') return write({type:'response',id:m.id,success:true,data:{}});
  if (m.method === 'thread/start') return write({id:m.id,result:{thread:{id:'thread'},model:'m',reasoningEffort:null}});
  if (m.method === 'collaborationMode/list' || m.method === 'skills/list') return write({id:m.id,result:{data:[]}});
  if (m.method === 'turn/start') write({id:m.id,result:{turn:{id:'t1',status:'inProgress'}}});
  else if (m.id !== undefined && m.method) return write({id:m.id,result:{}});
  if (m.type !== '${fixture.prompt}' && m.method !== 'turn/start') return;
  if (started) return;
  started = true;
  for (const e of turn) write(e);
  setTimeout(() => { for (const e of wake) write(e); }, 30);
});
`, { mode: 0o755 });
  const previous = process.env[fixture.variable];
  process.env[fixture.variable] = binary;
  const events: ProviderEvent[] = lastEvents = [];
  const ends = Promise.withResolvers<void>();
  let ended = 0;
  const provider = kind === "claude" ? claudeProvider() : kind === "codex" ? codexProvider() : piProvider();
  const session = provider.open({
    cwd: dir, config: {}, resumeId: null,
    emit(e) {
      events.push(e);
      if (e.type === "turnEnded" && ++ended === 2) ends.resolve();
    },
    async askPermission() { throw new Error("unexpected permission"); },
    async askQuestion() { throw new Error("unexpected question"); },
  });
  try {
    session.send("start a background job", "user-1", undefined, "casm-1");
    await ends.promise;
    return events.flatMap((e) =>
      e.type === "item" && e.item.kind === "assistant" ? [`item:${e.item.text}`]
      : e.type === "turnStarted" ? [`started:${e.notice ?? ""}`]
      : e.type === "turnEnded" ? [`ended:${e.outcome}:${e.turnId ?? "-"}`] : []);
  } finally {
    await session.close();
    if (previous === undefined) delete process.env[fixture.variable]; else process.env[fixture.variable] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Claude: a background Bash completing after the turn starts a turn of its own", { timeout: 10000 }, async () => {
  assert.deepEqual(await drive("claude", claude([notification, state("running"), init])), [
    "item:waiting", "ended:completed:casm-1",
    `started:Woken by a background task: ${notification.summary}`, "item:finished", "ended:completed:-",
  ]);
});

test("Claude: a Monitor event wakes the session without a task notification", { timeout: 10000 }, async () => {
  assert.deepEqual(await drive("claude", claude([state("running"), init])), [
    "item:waiting", "ended:completed:casm-1", "started:Woken by a background task", "item:finished", "ended:completed:-",
  ]);
});

test("Claude: a background subagent's report starts a turn with init alone (the session stays running)", { timeout: 10000 }, async () => {
  const agentDone = { ...notification, task_id: "a1", summary: "Agent finished" };
  assert.deepEqual(await drive("claude", { ...claude([agentDone, init]), turn: claude([]).turn.slice(0, -1) }), [
    "item:waiting", "ended:completed:casm-1", "started:Woken by a background task: Agent finished", "item:finished", "ended:completed:-",
  ]);
});

test("Codex: a turn Codex starts itself is adopted; a background terminal is not failed at turn end", { timeout: 10000 }, async () => {
  const msg = (turnId: string, id: string, text: string) => ({ method: "item/completed", params: { threadId: "thread", turnId, item: { type: "agentMessage", id, text } } });
  const exec = (status: string) => ({ method: status === "inProgress" ? "item/started" : "item/completed", params: { threadId: "thread", turnId: "t1", item: { type: "commandExecution", id: "exec-1", command: "sleep 20", cwd: "/", processId: "p1", status, ...(status === "completed" ? { aggregatedOutput: "done\n" } : {}) } } });
  const fixture: Fixture = {
    variable: "CASM_CODEX_PATH", prompt: "-",
    turn: [
      { method: "turn/started", params: { threadId: "thread", turn: { id: "t1" } } },
      exec("inProgress"), msg("t1", "m1", "waiting"),
      { method: "turn/completed", params: { threadId: "thread", turn: { id: "t1", status: "completed" } } },
    ],
    wake: [
      exec("completed"),
      { method: "turn/started", params: { threadId: "thread", turn: { id: "t2" } } },
      msg("t2", "m2", "finished"),
      { method: "turn/completed", params: { threadId: "thread", turn: { id: "t2", status: "completed" } } },
    ],
  };
  assert.deepEqual(await drive("codex", fixture), [
    "item:waiting", "ended:completed:casm-1", "started:Codex started a turn on its own", "item:finished", "ended:completed:-",
  ]);
  const execs = lastEvents.flatMap((e) => (e.type === "item" && e.item.kind === "tool" ? [[e.item.status, e.item.output ?? ""]] : []));
  assert.deepEqual(execs, [["running", ""], ["done", "done\n"]]);
});

test("pi: a run an extension starts while idle is adopted", { timeout: 10000 }, async () => {
  const assistant = (ts: number, text: string) => ({ type: "message_end", message: { role: "assistant", timestamp: ts, content: [{ type: "text", text }], stopReason: "stop" } });
  assert.deepEqual(await drive("pi", {
    variable: "CASM_PI_PATH", prompt: "prompt",
    turn: [{ type: "agent_start" }, assistant(1, "waiting"), { type: "agent_end" }, { type: "agent_settled" }],
    wake: [{ type: "agent_start" }, { type: "message_end", message: { role: "custom", customType: "file-trigger", content: "job done", display: true, timestamp: 2 } }, assistant(3, "finished"), { type: "agent_end" }, { type: "agent_settled" }],
  }), ["item:waiting", "ended:completed:casm-1", "started:A pi extension started a turn", "item:finished", "ended:completed:-"]);
});

// The manager: a provider's own turn runs as a turn; a message sent meanwhile
// queues behind it, and a stale end for the earlier turn doesn't end it.
test("the manager runs a provider's own turn as a turn and queues messages behind it", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-wake-manager-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const sessions: OpenOptions[] = [];
  const sent: string[] = [];
  const provider: Provider = {
    id: "codex",
    open(opts) {
      sessions.push(opts);
      return { send(text) { sent.push(text); }, shell() {}, async interrupt() {}, async close() {} };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const project = await client.call("project.create", { path: dir });
    const agent = (await client.call("agent.create", { projectId: project.id, provider: "codex" })).id;
    const status = async () => (await client.call("agent.get", { id: agent })).status;
    await client.call("agent.send", { id: agent, text: "start a job", messageId: crypto.randomUUID() });
    const emit = (e: ProviderEvent) => sessions[0]!.emit(e);
    emit({ type: "turnEnded", outcome: "completed" });
    assert.equal(await status(), "idle");

    emit({ type: "turnStarted", notice: "Woken by a background task: sleep 20" });
    assert.equal(await status(), "running");
    // Another turnStarted while it runs is the same turn.
    emit({ type: "turnStarted", notice: "again" });
    const queued = await client.call("agent.send", { id: agent, text: "after the wake", messageId: crypto.randomUUID() });
    assert.equal(queued.queued, true);
    emit({ type: "item", item: { kind: "assistant", id: "a2", text: "the job finished" } });
    // A late end of an earlier casm turn must not end this one.
    emit({ type: "turnEnded", outcome: "completed", turnId: "stale" });
    assert.equal(await status(), "running");
    const turn = (await client.call("agent.subscribe", { id: agent })).turn;
    assert.deepEqual(turn.filter((e) => e.type === "item").map((e) => e.type === "item" && e.item.kind === "notice" ? e.item.text : e.type === "item" ? e.item.kind : ""),
      ["Woken by a background task: sleep 20", "assistant"]);

    emit({ type: "turnEnded", outcome: "completed" });
    // The queued message goes next, as its own turn.
    assert.equal(await status(), "running");
    assert.deepEqual(sent, ["start a job", "after the wake"]);
    const waited = await client.call("agent.wait", { id: agent, timeoutMs: 1 });
    assert.equal(waited.status, "running");
  } finally {
    client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

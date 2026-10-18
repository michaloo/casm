// Archiving or deleting an agent (or its project) stops its provider process;
// unarchiving and sending resumes the same native session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CasmClient } from "@casm/client";
import type { ProviderId } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { piProvider } from "../src/providers/pi.ts";
import { OpencodeServer, opencodeProvider } from "../src/providers/opencode.ts";
import type { Provider } from "../src/providers/types.ts";

// One fake for every provider: it records its pid, argv and input in
// $FAKE_LOG/<pid>, answers just enough of each protocol for a turn to
// complete, and stays alive until killed or its stdin ends.
const FAKE = `
const { appendFileSync, writeFileSync } = require('node:fs');
const log = require('node:path').join(process.env.FAKE_LOG, String(process.pid));
writeFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
if (process.argv.includes('serve')) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const streams = new Set();
  const event = (type, properties) => { for (const s of streams) s.write('data: ' + JSON.stringify({ payload: { type, properties } }) + '\\n\\n'); };
  require('node:http').createServer((req, res) => {
    appendFileSync(log, req.method + ' ' + req.url + '\\n');
    const path = req.url.split('?')[0];
    if (path === '/global/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('\\n'); streams.add(res); return; }
    res.setHeader('content-type', 'application/json');
    if (path === '/config/providers') return res.end(JSON.stringify({ providers: [] }));
    if (req.method === 'POST' && path === '/session') return res.end(JSON.stringify({ id: 'ses_1' }));
    if (path.endsWith('/prompt_async')) {
      res.statusCode = 204; res.end();
      event('session.status', { sessionID: 'ses_1', status: { type: 'busy' } });
      return setTimeout(() => event('session.status', { sessionID: 'ses_1', status: { type: 'idle' } }), 20);
    }
    res.end(/message|children|command|agent/.test(path) ? '[]' : '{}');
  }).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
} else {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('close', () => process.exit(0));
  rl.on('line', line => {
    appendFileSync(log, line + '\\n');
    const m = JSON.parse(line);
    // Claude (stream-json)
    if (m.type === 'control_request') return write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.type === 'user') return write({ type: 'result', subtype: 'success', uuid: 'r' + Math.random(), session_id: m.session_id, is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {} });
    // pi (RPC)
    if (m.type === 'get_state') return write({ type: 'response', id: m.id, command: 'get_state', success: true, data: { sessionFile: process.env.FAKE_LOG + '/pi-session.jsonl' } });
    if (m.type === 'prompt') {
      write({ type: 'response', id: m.id, command: 'prompt', success: true });
      for (const type of ['agent_start', 'agent_end', 'agent_settled']) write({ type });
      return;
    }
    if (m.type) return write({ type: 'response', id: m.id, command: m.type, success: true, data: {} });
    // Codex (app-server JSON-RPC)
    if (m.id === undefined) return;
    if (m.method === 'thread/start' || m.method === 'thread/resume') return write({ id: m.id, result: { thread: { id: 'thread-1' }, model: 'm', reasoningEffort: null } });
    if (m.method === 'turn/start') {
      write({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } });
      write({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 't1' } } });
      return write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } });
    }
    write({ id: m.id, result: { data: [], nextCursor: null } });
  });
}
`;

const VARIABLES: Record<ProviderId, string> = { claude: "CASM_CLAUDE_PATH", codex: "CASM_CODEX_PATH", pi: "CASM_PI_PATH", opencode: "CASM_OPENCODE_PATH" };

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function setup(kind: ProviderId) {
  const dir = mkdtempSync(join(tmpdir(), `casm-archive-${kind}-`));
  const logs = mkdtempSync(join(tmpdir(), "casm-archive-log-"));
  const binary = join(dir, "fake.cjs");
  writeFileSync(binary, `#!${process.execPath}\n${FAKE}`, { mode: 0o755 });
  const saved = { [VARIABLES[kind]]: process.env[VARIABLES[kind]], FAKE_LOG: process.env.FAKE_LOG };
  process.env[VARIABLES[kind]] = binary;
  process.env.FAKE_LOG = logs;
  const provider: Provider =
    kind === "claude" ? claudeProvider() : kind === "codex" ? codexProvider() : kind === "pi" ? piProvider() : opencodeProvider(new OpencodeServer(50));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: kind, path: dir });
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  const create = async () => (await client.call("agent.create", { projectId: project.id, provider: kind })).id;
  const turn = async (id: string, text: string) => {
    await client.call("agent.send", { id, text });
    const r = await client.call("agent.wait", { id });
    assert.equal(r.lastTurn?.outcome, "completed", `turn: ${JSON.stringify(r)}`);
  };
  // Processes the fake started that are still running, with what they logged.
  const running = () =>
    readdirSync(logs).filter((f) => /^\d+$/.test(f) && alive(Number(f))).map((f) => ({ pid: Number(f), log: readFileSync(join(logs, f), "utf8") }));
  // Short-lived helpers (catalog, commands, history reads) exit on their own.
  const settle = async (count: number) => {
    for (let i = 0; i < 100 && running().length !== count; i++) await sleep(50);
    assert.equal(running().length, count, `running: ${JSON.stringify(running(), null, 1)}`);
    return running();
  };
  return {
    client, project, create, turn, running, settle,
    async cleanup() {
      client.close();
      await server.close();
      store.close();
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      for (const p of running()) process.kill(p.pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
      rmSync(logs, { recursive: true, force: true });
    },
  };
}

for (const kind of ["claude", "codex", "pi", "opencode"] as const) {
  test(`${kind}: archive stops the process, unarchive and send resume the session, delete stops it again`, { timeout: 30000 }, async () => {
    const t = await setup(kind);
    try {
      const id = await t.create();
      await t.turn(id, "one");
      const [first] = await t.settle(1);
      await t.client.call("agent.update", { id, archived: true });
      await t.settle(0);
      assert.equal((await t.client.call("agent.get", { id })).status, "idle");

      await t.client.call("agent.update", { id, archived: false });
      const native = (await t.client.call("agent.get", { id })).nativeSessionId;
      assert.ok(native);
      await t.turn(id, "two");
      const [second] = await t.settle(1);
      assert.notEqual(second.pid, first.pid);
      // OpenCode resumes in the shared server: no new POST /session.
      if (kind === "opencode") assert.doesNotMatch(second.log, /POST \/session\?/);
      else assert.ok(second.log.includes(native), `${native} not in ${second.log}`);

      await t.client.call("agent.delete", { id });
      await t.settle(0);
    } finally {
      await t.cleanup();
    }
  });
}

test("claude: restart stops the old process; project.delete stops every agent's", { timeout: 30000 }, async () => {
  const t = await setup("claude");
  try {
    const a = await t.create();
    const b = await t.create();
    await t.turn(a, "one");
    await t.turn(b, "one");
    const before = await t.settle(2);
    await t.client.call("agent.restart", { id: a });
    await t.turn(a, "two");
    const after = await t.settle(2);
    assert.equal(after.filter((p) => before.some((q) => q.pid === p.pid)).length, 1);
    await t.client.call("project.delete", { id: t.project.id });
    await t.settle(0);
  } finally {
    await t.cleanup();
  }
});

test("claude: archiving a project stops its agents' processes; sending resumes them", { timeout: 30000 }, async () => {
  const t = await setup("claude");
  try {
    const a = await t.create();
    const b = await t.create();
    await t.turn(a, "one");
    await t.turn(b, "one");
    await t.settle(2);
    await t.client.call("project.update", { id: t.project.id, archived: true });
    await t.settle(0);
    const native = (await t.client.call("agent.get", { id: a })).nativeSessionId;
    assert.ok(native);
    await t.client.call("project.update", { id: t.project.id, archived: false });
    await t.turn(a, "two");
    const [resumed] = await t.settle(1);
    assert.ok(resumed.log.includes(native), `${native} not in ${resumed.log}`);
  } finally {
    await t.cleanup();
  }
});

test("archiving mid-turn interrupts the turn, then closes; queued messages wait", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-archive-turn-"));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "p", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: dir, config: {} });
  const token = store.createToken("test");
  const calls: string[] = [];
  const provider: Provider = {
    id: "claude",
    open(opts) {
      calls.push(`open:${opts.resumeId}`);
      queueMicrotask(() => opts.emit({ type: "sessionId", id: "native-1" }));
      return {
        send(text) {
          calls.push(`send:${text}`);
          if (text !== "long") setImmediate(() => opts.emit({ type: "turnEnded", outcome: "completed" }));
        },
        shell() {},
        async interrupt() {
          calls.push("interrupt");
          setImmediate(() => opts.emit({ type: "turnEnded", outcome: "interrupted" }));
        },
        async close() { calls.push("close"); },
      };
    },
    async history() { return []; },
    async catalog() { return { models: [], modes: [] }; },
    async commands() { return []; },
    async usage() { return null; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    await client.call("agent.send", { id: agent.id, text: "long" });
    await client.call("agent.send", { id: agent.id, text: "queued", whenBusy: "queue" });
    await client.call("agent.update", { id: agent.id, archived: true });
    assert.deepEqual(calls, ["open:null", "send:long", "interrupt", "close"]);
    assert.equal((await client.call("agent.get", { id: agent.id })).status, "idle");
    assert.deepEqual((await client.call("agent.pending", { id: agent.id })).messages.map((m) => m.text), ["queued"]);
    await client.call("agent.update", { id: agent.id, archived: false });
    await client.call("agent.send", { id: agent.id, text: "back" });
    await client.call("agent.wait", { id: agent.id });
    assert.deepEqual(calls.slice(4, 5), ["open:native-1"]);
  } finally {
    client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

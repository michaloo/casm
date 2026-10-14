import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { parseMcpStatus, piProvider } from "../src/providers/pi.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// What pi 1.1.0's /mcp prints in RPC mode (captured from the real binary).
const STATUS = `dead: failed (codemode)
    fetch failed
casm: connected, 11 tools (direct)
files: needs sign-in, run /mcp login files (codemode)
docs: disabled (direct)
slow: starting (codemode)
drop: disconnected, reconnects on next call (deferred)
config error: "bad" in /home/u/.pi/agent/mcp.json: sse is not supported
overridden: "x" registered by /ext.ts is overridden by "x" in /home/u/.pi/agent/mcp.json`;

test("pi /mcp status text: states, tool counts, errors and which servers casm can toggle", () => {
  assert.deepEqual(parseMcpStatus(STATUS, new Set(["casm", "docs"])), [
    { name: "dead", status: "failed", tools: 0, toolsKnown: false, canToggle: false, error: "fetch failed" },
    { name: "casm", status: "connected", tools: 11 },
    { name: "files", status: "needs-auth", tools: 0, toolsKnown: false, canToggle: false },
    { name: "docs", status: "disabled", tools: 0, toolsKnown: false },
    { name: "slow", status: "pending", tools: 0, toolsKnown: false, canToggle: false },
    { name: "drop", status: "pending", tools: 0, toolsKnown: false, error: "disconnected; reconnects on its next call", canToggle: false },
  ]);
});

// A pi RPC stand-in: logs argv, the casm MCP env and every command, and runs
// /mcp, /mcp reconnect and /casm-mcp the way pi 1.1.0 does (notify, then the
// handled response). Each status also has a stray notify from elsewhere.
async function fakePi(dir: string, builtinMcp = true) {
  const bin = join(dir, "fake-pi.cjs");
  const log = join(dir, "pi.log");
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const log = m => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2), servers: process.env.CASM_PI_MCP_SERVERS ?? null });
const state = { casm: 'connected, 11 tools', docs: 'connected, 2 tools', files: 'failed' };
let n = 0;
const notify = (message, notifyType = 'info') => write({ type: 'extension_ui_request', id: 'n' + ++n, method: 'notify', message, notifyType });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  log({ command: m.type, message: m.message });
  const ok = data => write({ type: 'response', id: m.id, command: m.type, success: true, data });
  if (m.type === 'get_state') return ok({ sessionFile: ${JSON.stringify(join(dir, "session.jsonl"))} });
  if (m.type === 'get_commands') return ok({ commands: ${builtinMcp} ? [{ name: 'mcp', source: 'extension', sourceInfo: { path: 'builtin:mcp' } }] : [] });
  if (m.type !== 'prompt') return;
  const [cmd, action, name] = m.message.split(' ');
  if (cmd === '/mcp' && !action) {
    notify(Object.entries(state).map(([k, v]) => k + ': ' + v + ' (direct)' + (v === 'failed' ? '\\n    connection refused' : '')).join('\\n'));
    notify('MCP servers need attention: files', 'warning');
  } else if (cmd === '/mcp' && action === 'reconnect') {
    if (!state[name]) notify('No MCP server named "' + name + '".', 'error');
    else if (state[name] === 'failed') notify('connection refused', 'error');
    else notify('Reconnected to MCP server "' + name + '" (connected).');
  } else if (cmd === '/casm-mcp') {
    state[name] = action === 'enable' ? 'starting' : 'disabled';
    notify('casm-mcp: ' + name + ' ' + action + 'd');
  } else return ok({ disposition: 'started' });
  ok({ disposition: 'handled' });
  notify('unrelated status line');
});
`, { mode: 0o755 });
  return { bin, log: async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)) };
}

test("pi agents get casm tools and config.mcpServers; native MCP status, reconnect and toggle", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "casm-pi-mcp-"));
  const pi = await fakePi(home);
  const previous = process.env.CASM_PI_PATH;
  process.env.CASM_PI_PATH = pi.bin;
  const store = new Store(join(home, "test.db"));
  const server = await startServer({ store, providers: [piProvider()], host: "127.0.0.1", port: 0, version: "test", home });
  const client = await CasmClient.connect(server.url, store.createToken("test"));
  t.after(async () => {
    client.close(); await server.close(); store.close();
    if (previous === undefined) delete process.env.CASM_PI_PATH; else process.env.CASM_PI_PATH = previous;
    await rm(home, { recursive: true, force: true });
  });
  const project = await client.call("project.create", { name: "test", path: home });
  const docs = { type: "http", url: "http://127.0.0.1:9/docs" };
  const agent = await client.call("agent.create", { projectId: project.id, provider: "pi", name: "pi MCP", config: { casmTools: true, mcpServers: { docs } } });

  const status = await client.call("agent.mcpStatus", { id: agent.id });
  assert.deepEqual(status, {
    reconnect: "server", canToggle: true,
    servers: [
      { name: "casm", status: "connected", tools: 11 },
      { name: "docs", status: "connected", tools: 2 },
      { name: "files", status: "failed", tools: 0, toolsKnown: false, canToggle: false, error: "connection refused" },
    ],
  });

  // The session gets casm's server (with an agent token) and config.mcpServers through the extension.
  // Catalog and command queries run their own short-lived `--no-session` processes.
  const sessions = async () => (await pi.log()).filter((l) => l.argv && !l.argv.includes("--no-session"));
  const [start] = await sessions();
  assert.ok(start.argv.some((a: string) => a.endsWith("providers/pi-extension.ts")), "the MCP extension is loaded");
  const servers = JSON.parse(start.servers);
  assert.deepEqual(servers.docs, docs);
  assert.equal(servers.casm.url, `http://127.0.0.1:${server.port}/mcp`);
  assert.equal(servers.casm.exposure, "direct");
  const tools = await fetch(servers.casm.url, {
    method: "POST", headers: { "content-type": "application/json", ...servers.casm.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).then((r) => r.json());
  assert.ok(tools.result.tools.some((x: { name: string }) => x.name === "create_agent"), "the token authenticates as this agent");
  assert.deepEqual((await client.call("agent.get", { id: agent.id })).config, { casmTools: true, mcpServers: { docs } });

  // The host prompt's {{casmTools}} line applies to pi now.
  assert.match((await client.call("server.agentPrompt", { agentId: agent.id })).rendered ?? "", /casm MCP tools \(server "casm"/);

  assert.deepEqual(await client.call("agent.mcpReconnect", { id: agent.id, server: "docs" }), { mode: "native", message: 'Reconnected to MCP server "docs" (connected).' });
  await assert.rejects(client.call("agent.mcpReconnect", { id: agent.id, server: "nope" }), /No MCP server named "nope"/);
  await assert.rejects(client.call("agent.mcpReconnect", { id: agent.id }), /connection refused/, "reconnect all reports the failing server");

  await client.call("agent.mcpToggle", { id: agent.id, server: "docs", enabled: false });
  assert.equal((await client.call("agent.mcpStatus", { id: agent.id })).servers.find((s) => s.name === "docs")?.status, "disabled");
  await assert.rejects(client.call("agent.mcpToggle", { id: agent.id, server: "files", enabled: false }), /mcp\.json/);

  const prompts = (await pi.log()).filter((l) => l.command === "prompt").map((l) => l.message);
  assert.deepEqual(prompts, [
    "/mcp", "/mcp reconnect docs", "/mcp reconnect nope",
    "/mcp", "/mcp reconnect casm", "/mcp reconnect docs", "/mcp reconnect files",
    "/casm-mcp disable docs", "/mcp",
  ]);
  assert.equal((await sessions()).length, 1, "one session, no reloads");
});

test("pi MCP: command output is not a transcript notice; other notifications still are", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "casm-pi-mcp-"));
  const pi = await fakePi(dir);
  const previous = process.env.CASM_PI_PATH;
  process.env.CASM_PI_PATH = pi.bin;
  const events: ProviderEvent[] = [];
  const session = piProvider().open({
    cwd: dir, config: {}, resumeId: null, emit: (e) => events.push(e),
    askPermission: async () => { throw new Error("unexpected"); }, askQuestion: async () => null,
  });
  t.after(async () => {
    await session.close();
    if (previous === undefined) delete process.env.CASM_PI_PATH; else process.env.CASM_PI_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  });
  // No MCP servers from casm: no extension, nothing to toggle.
  assert.equal(session.mcpToggle, undefined);
  assert.equal((await session.mcpStatus!()).length, 3);
  await new Promise((r) => setTimeout(r, 50));
  const notices = events.flatMap((e) => (e.type === "item" && e.item.kind === "notice" ? [e.item.text] : []));
  assert.deepEqual(notices, ["unrelated status line"]);
  const [start] = await pi.log();
  assert.equal(start.argv.some((a: string) => a.endsWith("pi-extension.ts")), false);
  assert.equal(start.servers, null);
});

test("pi without its built-in MCP support falls back to session reload", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "casm-pi-mcp-"));
  const pi = await fakePi(home, false);
  const previous = process.env.CASM_PI_PATH;
  process.env.CASM_PI_PATH = pi.bin;
  const store = new Store(join(home, "test.db"));
  const server = await startServer({ store, providers: [piProvider()], host: "127.0.0.1", port: 0, version: "test", home });
  const client = await CasmClient.connect(server.url, store.createToken("test"));
  t.after(async () => {
    client.close(); await server.close(); store.close();
    if (previous === undefined) delete process.env.CASM_PI_PATH; else process.env.CASM_PI_PATH = previous;
    await rm(home, { recursive: true, force: true });
  });
  const project = await client.call("project.create", { name: "test", path: home });
  const agent = await client.call("agent.create", { projectId: project.id, provider: "pi", name: "no MCP" });
  const status = await client.call("agent.mcpStatus", { id: agent.id });
  assert.equal(status.reconnect, "reload");
  assert.match(status.message ?? "", /no native MCP status/);
  assert.equal((await client.call("agent.mcpReconnect", { id: agent.id })).mode, "reload");
  assert.equal((await pi.log()).filter((l) => l.command === "prompt").length, 0, "/mcp is never sent as a model prompt");
});

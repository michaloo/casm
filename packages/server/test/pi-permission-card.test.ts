import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { permissionValue, piProvider } from "../src/providers/pi.ts";
import { MARKER } from "../src/providers/pi-permissions.ts";

test("permission select answers: choice, then the edited rule or the deny reason", () => {
  assert.equal(permissionValue("allow", "ignored"), "Approve");
  assert.equal(permissionValue("allowAlways"), "Always");
  assert.equal(permissionValue("allowAlways", "npm test *\ngit diff"), "Always\nnpm test *\ngit diff");
  assert.equal(permissionValue("deny", "no"), "Deny\nno");
  assert.equal(permissionValue("deny"), "Deny");
});

// pi stand-in: every prompt runs one gated bash call through casm's marker
// select, logs the extension_ui_response, then settles. /casm-mode is handled
// like the extension's command.
async function fakePi(dir: string) {
  const bin = join(dir, "fake-pi.cjs");
  const log = join(dir, "pi.log");
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const log = m => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
if (!process.argv.includes('--no-session')) log({ argv: process.argv.slice(2), mode: process.env.CASM_PI_MODE });
let ask = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  const ok = data => write({ type: 'response', id: m.id, command: m.type, success: true, data });
  if (m.type === 'get_state') return ok({ sessionFile: ${JSON.stringify(join(dir, "session.jsonl"))} });
  if (m.type === 'get_available_models') return ok({ models: [] });
  if (m.type === 'get_commands') return ok({ commands: [] });
  if (m.type === 'extension_ui_response') { log({ response: m }); write({ type: 'agent_settled' }); return; }
  if (m.type !== 'prompt') return;
  log({ prompt: m.message });
  if (m.message.startsWith('/casm-mode ')) {
    write({ type: 'extension_ui_request', id: 'mode', method: 'notify', message: 'casm-mode: ' + m.message.split(' ')[1], notifyType: 'info' });
    return ok({ disposition: 'handled' });
  }
  ok({ disposition: 'started' });
  const rule = { kind: 'bash', value: 'npm test *', editable: true, file: '/p/.pi/settings.json' };
  write({ type: 'extension_ui_request', id: 'ask-' + ++ask, method: 'select', title: ${JSON.stringify(MARKER)} + JSON.stringify({ tool: 'bash', input: { command: 'npm test -- -w' }, rule }), options: ['Approve', 'Always', 'Deny'] });
});
`, { mode: 0o755 });
  return { bin, log: async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)) };
}

test("pi: casm's permission select is a permission card with Always and an editable rule; modes apply live", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "casm-pi-perm-card-"));
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
  assert.deepEqual((await client.call("provider.catalog", { provider: "pi" })).modes.map((m) => m.id), ["default", "acceptEdits", "bypass"]);
  const project = await client.call("project.create", { name: "test", path: home });
  await assert.rejects(client.call("agent.create", { projectId: project.id, provider: "pi", config: { mode: "plan" } }), /unknown pi mode/);
  const agent = await client.call("agent.create", { projectId: project.id, provider: "pi", name: "gated", config: { mode: "acceptEdits" }, prompt: "test it" });

  const pending = async () => {
    assert.equal((await client.call("agent.wait", { id: agent.id, timeoutMs: 5000 })).status, "waiting");
    const { permissions } = await client.call("agent.subscribe", { id: agent.id });
    await client.call("agent.unsubscribe", { id: agent.id });
    return permissions;
  };
  const [first] = await pending();
  assert.deepEqual({ ...first, id: undefined }, {
    id: undefined, toolName: "bash", input: { command: "npm test -- -w" }, canAlwaysAllow: true,
    rule: { kind: "bash", value: "npm test *", editable: true, savedTo: "/p/.pi/settings.json" },
  });
  await client.call("agent.respondPermission", { id: agent.id, requestId: first.id, decision: "allowAlways", rule: "npm test *\nnpm run lint" });
  assert.equal((await client.call("agent.wait", { id: agent.id, timeoutMs: 5000 })).status, "idle");

  await client.call("agent.send", { id: agent.id, text: "again" });
  const [second] = await pending();
  await client.call("agent.respondPermission", { id: agent.id, requestId: second.id, decision: "deny", message: "use make" });
  await client.call("agent.wait", { id: agent.id, timeoutMs: 5000 });

  await client.call("agent.update", { id: agent.id, config: { mode: "bypass" } });
  await new Promise((r) => setTimeout(r, 200));
  const lines = await pi.log();
  assert.deepEqual(lines.filter((l) => l.response).map((l) => l.response.value), ["Always\nnpm test *\nnpm run lint", "Deny\nuse make"]);
  const sessions = lines.filter((l) => l.argv);
  assert.equal(sessions.length, 1, "a mode change does not restart pi");
  assert.equal(sessions[0].mode, "acceptEdits");
  assert.match(sessions[0].argv[sessions[0].argv.indexOf("-e") + 1], /providers\/pi-permissions\.ts$/);
  assert.equal(lines.filter((l) => l.prompt).at(-1).prompt, "/casm-mode bypass");
  assert.equal((await client.call("agent.get", { id: agent.id })).config.mode, "bypass");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import type { Provider, ProviderEvent } from "../src/providers/types.ts";

async function until(ready: () => boolean) {
  for (const deadline = Date.now() + 5000; !ready(); await new Promise((r) => setTimeout(r, 20)))
    if (Date.now() > deadline) throw new Error("timed out waiting");
}

test("Claude reports its permission mode from system/init and system/status", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-mode-"));
  const binary = join(dir, "fake-claude");
  // As the SDK streams it: init in plan mode, then status once ExitPlanMode is allowed.
  writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') write({type: 'control_response', response: {subtype: 'success', request_id: m.request_id, response: {}}});
  if (m.type !== 'user') return;
  write({type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-haiku', uuid: 'init-1',
    cwd: ${JSON.stringify(dir)}, tools: [], mcp_servers: [], permissionMode: 'plan', slash_commands: [], apiKeySource: 'none', output_style: 'default'});
  write({type: 'system', subtype: 'status', status: null, permissionMode: 'default', uuid: 's-1', session_id: 'native-1'});
});
`, { mode: 0o755 });
  const oldPath = process.env.CASM_CLAUDE_PATH;
  process.env.CASM_CLAUDE_PATH = binary;
  const events: ProviderEvent[] = [];
  const session = claudeProvider().open({
    cwd: dir, config: { mode: "plan" }, resumeId: null, emit: (e) => events.push(e),
    askPermission: async () => { throw new Error("unexpected permission"); },
    askQuestion: async () => { throw new Error("unexpected question"); },
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CLAUDE_PATH; else process.env.CASM_CLAUDE_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("plan it", "user-1");
  await until(() => events.filter((e) => e.type === "mode").length === 2);
  assert.deepEqual(events.filter((e) => e.type === "mode"), [{ type: "mode", mode: "plan" }, { type: "mode", mode: "default" }]);
});

test("a mode the session switched to becomes the agent's mode without reopening it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-mode-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  let opens = 0;
  let emit: ((e: ProviderEvent) => void) | null = null;
  const provider: Provider = {
    id: "claude",
    open(opts) {
      opens++;
      emit = opts.emit;
      return { send() {}, shell() {}, async interrupt() {}, async close() {} };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; },
    async catalog() { return { models: [], modes: ["plan", "default", "acceptEdits"].map((id) => ({ id })) }; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const project = await client.call("project.create", { path: dir });
    const agent = await client.call("agent.create", { projectId: project.id, provider: "claude", config: { mode: "plan" } });
    await client.call("agent.send", { id: agent.id, text: "plan it" });
    emit!({ type: "mode", mode: "plan" });
    emit!({ type: "mode", mode: "default" });
    await until(() => store.getAgent(agent.id)?.config.mode === "default");
    emit!({ type: "turnEnded", outcome: "completed" });
    await client.call("agent.send", { id: agent.id, text: "now build it" });
    assert.equal(opens, 1);
    assert.equal((await client.call("agent.get", { id: agent.id })).config.mode, "default");
    // A mode change the user asked for during the turn wins over the session's.
    await client.call("agent.update", { id: agent.id, config: { mode: "acceptEdits" } });
    emit!({ type: "mode", mode: "plan" });
    assert.equal(store.getAgent(agent.id)?.config.mode, "acceptEdits");
  } finally {
    client.close(); await server.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexProvider } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Polls until `ready` holds; throws after 5 s so a broken session fails instead of hanging.
async function until(ready: () => boolean) {
  for (const deadline = Date.now() + 5000; !ready(); await new Promise((r) => setTimeout(r, 20)))
    if (Date.now() > deadline) throw new Error("timed out waiting");
}


// A fake app-server that logs thread/start and thread/resume params and answers every request.
function fakeCodex(dir: string) {
  const binary = join(dir, "fake-codex.cjs");
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
  let result = {};
  if (m.method === 'thread/start' || m.method === 'thread/resume') result = {thread:{id:'thread'}, model:'fake', reasoningEffort:null};
  if (m.method === 'collaborationMode/list' || m.method === 'skills/list') result = {data:[]};
  if (m.method === 'thread/items/list') result = {data:[], nextCursor:null};
  write({id:m.id,result});
});
`, { mode: 0o755 });
  return { binary, requests: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

for (const resumeId of [null, "thread-1"]) {
  test(`Codex ${resumeId ? "resumed" : "new"} threads ask for detailed reasoning summaries, keep MCP servers and report their model`, { timeout: 10000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "casm-codex-reasoning-"));
    const fake = fakeCodex(dir);
    const oldPath = process.env.CASM_CODEX_PATH;
    process.env.CASM_CODEX_PATH = fake.binary;
    const mcpServers = { docs: { command: "docs-mcp" } };
    const events: ProviderEvent[] = [];
    const session = codexProvider().open({
      cwd: dir, config: { mcpServers }, resumeId,
      emit: (e) => events.push(e),
      askPermission: async () => { throw new Error("unexpected permission"); },
      askQuestion: async () => { throw new Error("unexpected question"); },
    });
    t.after(async () => {
      await session.close();
      if (oldPath === undefined) delete process.env.CASM_CODEX_PATH;
      else process.env.CASM_CODEX_PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    });
    await until(() => fake.requests().length > 0);
    const [request] = fake.requests();
    assert.equal(request.method, resumeId ? "thread/resume" : "thread/start");
    assert.deepEqual(request.params.config, { model_reasoning_summary: "detailed", mcp_servers: mcpServers });
    // No config.model: the model the thread runs is Codex's own default, reported as the effective model.
    await until(() => events.some((e) => e.type === "model"));
    assert.deepEqual(events.find((e) => e.type === "model"), { type: "model", model: "fake" });
  });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexProvider, normalize } from "../src/providers/codex.ts";
import type { PermissionRequest } from "@casm/protocol";
import type { ProviderEvent } from "../src/providers/types.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("Codex image generation shows the image and keeps the base64 out of the tool input", () => {
  const item = { type: "imageGeneration", id: "ig", status: "completed", revisedPrompt: "a cat", result: PNG, savedPath: "/tmp/ig.png" };
  assert.deepEqual(normalize(item), {
    kind: "tool", id: "ig", name: "image_generation", input: { prompt: "a cat" }, status: "done",
    output: "Saved to /tmp/ig.png", images: [{ mediaType: "image/png", data: PNG }],
  });
  const failed = normalize({ type: "imageGeneration", id: "ig2", status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "x", resetsAt: null } });
  assert.deepEqual(failed, { kind: "tool", id: "ig2", name: "image_generation", input: { prompt: "" }, status: "error", output: "Image generation failed: usageLimitExceeded" });
});

// A fake app-server: on turn/start it reroutes, changes the thread's model, asks
// a URL elicitation and logs the answer, then completes the turn.
test("Codex reports reroutes and settings changes as the effective model and asks URL elicitations", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-coverage-"));
  const binary = join(dir, "fake-codex.cjs");
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => write({method, params});
createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'elicit') {
    notify('warning', {threadId:'thread', message:'elicitation answer ' + JSON.stringify(m.result)});
    notify('turn/completed', {threadId:'thread', turn:{id:'turn', status:'completed'}});
    return;
  }
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'thread/start') result = {thread:{id:'thread'}, model:'gpt-a', reasoningEffort:null};
  if (m.method === 'collaborationMode/list' || m.method === 'skills/list') result = {data:[]};
  if (m.method === 'turn/start') result = {turn:{id:'turn',status:'inProgress'}};
  write({id:m.id,result});
  if (m.method !== 'turn/start') return;
  notify('turn/started', {threadId:'thread', turn:{id:'turn'}});
  notify('model/rerouted', {threadId:'thread', turnId:'turn', fromModel:'gpt-a', toModel:'gpt-b', reason:'highRiskCyberActivity'});
  notify('thread/settings/updated', {threadId:'thread', threadSettings:{model:'gpt-b'}});
  notify('thread/settings/updated', {threadId:'thread', threadSettings:{model:'gpt-c'}});
  write({id:'elicit', method:'mcpServer/elicitation/request', params:{threadId:'thread', turnId:'turn', serverName:'docs', mode:'url', message:'Sign in to Docs', url:'https://docs.example/login', elicitationId:'el-1'}});
});
`, { mode: 0o755 });
  const oldPath = process.env.CASM_CODEX_PATH;
  process.env.CASM_CODEX_PATH = binary;
  const events: ProviderEvent[] = [];
  const asked: PermissionRequest[] = [];
  const ended = Promise.withResolvers<void>();
  const session = codexProvider().open({
    cwd: dir, config: {}, resumeId: null,
    emit: (e) => { events.push(e); if (e.type === "turnEnded") ended.resolve(); },
    askPermission: async (req) => (asked.push(req), { decision: "allow" }),
    askQuestion: async () => { throw new Error("unexpected question"); },
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("go", "id-1", undefined, "turn-1");
  await ended.promise;
  assert.deepEqual(events.filter((e) => e.type === "model").map((e) => e.type === "model" && e.model), ["gpt-a", "gpt-b", "gpt-c"]);
  assert.deepEqual(asked.map((r) => [r.id, r.toolName, r.title, r.input]), [["el-1", "mcp__docs", "Sign in to Docs https://docs.example/login", { message: "Sign in to Docs", url: "https://docs.example/login" }]]);
  assert.ok(events.some((e) => e.type === "item" && e.item.kind === "notice" && e.item.text.includes('elicitation answer {"action":"accept","content":null,"_meta":null}')));
});

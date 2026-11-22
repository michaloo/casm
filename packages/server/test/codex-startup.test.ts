import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexProvider } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const child = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } };
const turns = [
  { id: "t1", status: "completed", startedAt: 1700000000, completedAt: 1700000002, items: [
    { type: "userMessage", id: "native-user", clientId: "user", content: [{ type: "text", text: "Review" }] },
    { type: "commandExecution", id: "shell", command: "pwd", status: "completed", aggregatedOutput: "/repo" },
    child,
    { type: "agentMessage", id: "answer", text: "Done" },
  ] },
  { id: "t2", status: "failed", startedAt: 1700000003, completedAt: 1700000004, error: { message: "Turn failed" }, items: [
    { type: "subAgentActivity", id: "finished", agentThreadId: "child", kind: "completed" },
  ] },
  { id: "t3", status: "failed", completedAt: 1700000005, error: { message: "Failed before any items" }, items: [] },
];

function setup(t: TestContext, options: { historyError?: number; readError?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-startup-"));
  const binary = join(dir, "codex.cjs");
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const turns = ${JSON.stringify(turns)};
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + '\\n');
  if (m.method === 'thread/items/list') return write({id:m.id,error:{code:${options.historyError ?? -32601},message:'thread/items/list is not supported yet'}});
  if (m.method === 'thread/read' && ${!!options.readError}) return write({id:m.id,error:{code:-32600,message:'thread not loaded: missing'}});
  let result = {};
  if (m.method === 'thread/read') result = {thread:{turns:m.params.threadId === 'child' ? [{id:'ct',status:'completed',items:[{type:'agentMessage',id:'private',text:'CHILD_ONLY'}]}] : turns}};
  if (m.method === 'thread/start' || m.method === 'thread/resume') result = {thread:{id:'parent'},model:'gpt-6-astra',reasoningEffort:'medium'};
  if (m.method === 'skills/list' || m.method === 'collaborationMode/list') result = {data:[]};
  if (m.method === 'turn/start') {
    if (m.params.effort === '' || m.params.effort?.trim() === '') return write({id:m.id,error:{code:-32600,message:'reasoning_effort must not be empty'}});
    result = {turn:{id:'turn',status:'inProgress'}};
  }
  write({id:m.id,result});
  if (m.method === 'turn/start') write({method:'turn/completed',params:{threadId:'parent',turn:{id:'turn',status:'completed'}}});
});
`, { mode: 0o755 });
  const oldPath = process.env.CASM_CODEX_PATH;
  const oldBundle = process.env.CASM_CODEX_BIN_DIR;
  delete process.env.CASM_CODEX_BIN_DIR;
  process.env.CASM_CODEX_PATH = binary;
  // Windows cannot execute a shebang script directly. Keep the production
  // executable resolver unchanged and launch only this fixture through Node.
  if (process.platform === "win32") {
    const original = childProcess.spawn;
    t.mock.method(childProcess, "spawn", (file: string, args: string[], options: any) =>
      file === binary ? original(process.execPath, [file, ...args], options) : original(file, args, options));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  t.after(async () => {
    if (oldBundle === undefined) delete process.env.CASM_CODEX_BIN_DIR;
    else process.env.CASM_CODEX_BIN_DIR = oldBundle;
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH;
    else process.env.CASM_CODEX_PATH = oldPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, requests: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

for (const effort of [undefined, "", "  ", "high"]) {
  test(`Codex starts with effort ${JSON.stringify(effort) ?? "omitted"}`, { timeout: 5000 }, async t => {
    const fake = setup(t);
    const ended = Promise.withResolvers<ProviderEvent>();
    const session = codexProvider().open({ cwd: fake.dir, config: { model: "gpt-6-astra", effort }, resumeId: null,
      emit: e => { if (e.type === "turnEnded" || e.type === "closed") ended.resolve(e); },
      askPermission: async () => { throw new Error("unexpected approval"); }, askQuestion: async () => null,
    });
    try {
      session.send("hello", "user");
      const event = await ended.promise;
      assert.equal(event.type === "turnEnded" && event.outcome, "completed", JSON.stringify(event));
      const params = fake.requests().find(r => r.method === "turn/start").params;
      assert.equal(params.effort, effort?.trim() || undefined);
      assert.equal(Object.hasOwn(params, "effort"), !!effort?.trim());
      assert.equal(params.collaborationMode.settings.reasoning_effort, effort?.trim() || "medium");
    } finally { await session.close(); }
  });
}

test("Codex unsupported item history falls back with stable IDs, child cards, times and failed-turn notices", async t => {
  const fake = setup(t);
  const provider = codexProvider();
  const history = await provider.history("parent", fake.dir);
  assert.deepEqual(history.map(i => [i.id, i.kind]), [
    ["user", "user"], ["shell", "tool"], ["child", "subagent"], ["answer", "assistant"],
    ["error-t2", "notice"], ["error-t3", "notice"],
  ]);
  assert.equal(history[0].at, "2023-11-14T22:13:20.000Z");
  assert.equal(history[1].kind === "tool" && history[1].endedAt, "2023-11-14T22:13:22.000Z");
  assert.equal(history[2].kind === "subagent" && history[2].status, "done");
  assert.equal(history[2].at, history[0].at);
  assert.equal(history[4].kind === "notice" && history[4].text, "Turn failed");
  assert.equal(history[5].kind === "notice" && history[5].text, "Failed before any items");
  assert.deepEqual(fake.requests().find(r => r.method === "thread/read").params, { threadId: "parent", includeTurns: true });
  assert.deepEqual(await provider.subagentHistory!("parent", fake.dir, "child"), [{ kind: "assistant", id: "private", text: "CHILD_ONLY" }]);
  await assert.rejects(provider.subagentHistory!("parent", fake.dir, "stranger"), /Unknown Codex subagent/);
});

test("Codex resumes and starts a default-effort turn when paginated history is unavailable", { timeout: 5000 }, async t => {
  const fake = setup(t);
  const ended = Promise.withResolvers<ProviderEvent>();
  const session = codexProvider().open({ cwd: fake.dir, config: { model: "gpt-6-astra", effort: "" }, resumeId: "parent",
    emit: e => { if (e.type === "turnEnded" || e.type === "closed") ended.resolve(e); },
    askPermission: async () => { throw new Error("unexpected approval"); }, askQuestion: async () => null,
  });
  try {
    session.send("continue", "user2");
    const event = await ended.promise;
    assert.equal(event.type === "turnEnded" && event.outcome, "completed", JSON.stringify(event));
    const methods = fake.requests().map(r => r.method);
    assert.ok(methods.indexOf("thread/read") < methods.indexOf("thread/resume"));
    assert.equal(fake.requests().find(r => r.method === "thread/resume").params.threadId, "parent");
  } finally { await session.close(); }
});

for (const code of [-32600, -32603]) {
  test(`Codex history propagates error ${code} instead of treating it as an unsupported method`, async t => {
    const fake = setup(t, { historyError: code });
    await assert.rejects(codexProvider().history("parent", fake.dir), { code });
    assert.ok(!fake.requests().some(r => r.method === "thread/read"));
  });
}

test("Codex history surfaces a missing thread from the fallback", async t => {
  const fake = setup(t, { readError: true });
  await assert.rejects(codexProvider().history("missing", fake.dir), /thread not loaded: missing/);
});

test("Codex reads live history over its existing connection", async t => {
  const fake = setup(t);
  const session = codexProvider().open({ cwd: fake.dir, config: {}, resumeId: null,
    emit() {}, askPermission: async () => { throw new Error("unexpected"); }, askQuestion: async () => null,
  });
  try {
    const items = await session.history!();
    assert.ok(items.some(i => i.kind === "assistant" && i.id === "answer"));
    assert.ok(items.some(i => i.kind === "notice" && i.id === "error-t3"));
    assert.equal(fake.requests().filter(r => r.method === "initialize").length, 1);
  } finally { await session.close(); }
});

test("Codex history snapshots coalesce reads and invalidate on external transcript changes", async t => {
  const fake = setup(t);
  mkdirSync(join(fake.dir, "sessions"));
  const file = join(fake.dir, "sessions", "rollout-test-parent.jsonl");
  writeFileSync(file, "first");
  const childFile = join(fake.dir, "sessions", "rollout-test-child.jsonl");
  writeFileSync(childFile, "child");
  const provider = codexProvider();
  const context = { env: { CODEX_HOME: fake.dir } };
  const [one, two] = await Promise.all([provider.history("parent", fake.dir, context), provider.history("parent", fake.dir, context)]);
  assert.deepEqual(one, two);
  assert.equal(fake.requests().filter(r => r.method === "initialize").length, 1);
  await provider.history("parent", fake.dir, context);
  assert.equal(fake.requests().filter(r => r.method === "initialize").length, 1);
  appendFileSync(file, "external change");
  await provider.history("parent", fake.dir, context);
  assert.equal(fake.requests().filter(r => r.method === "initialize").length, 2);
  appendFileSync(childFile, "new child reply");
  await provider.history("parent", fake.dir, context);
  assert.equal(fake.requests().filter(r => r.method === "initialize").length, 3);
});

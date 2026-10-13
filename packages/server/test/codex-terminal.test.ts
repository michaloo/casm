import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexProvider, terminalInteraction } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const params = { threadId: "thread", turnId: "turn", itemId: "shell", processId: "pty-1", stdin: "yes\n" };

test("Codex terminal cards preserve control characters and bound input without finishing the command", () => {
  const item = terminalInteraction({ ...params, stdin: "\u0003\n" }, "input-1", "npm test");
  assert.deepEqual(item, {
    kind: "tool", id: "input-1", name: "terminal", status: "done",
    input: { processId: "pty-1", itemId: "shell", stdin: "\u0003\n", command: "npm test" },
  });
  const big = terminalInteraction({ ...params, stdin: "x".repeat(10000) }, "input-2")!;
  assert.ok(String((big.input as { stdin: string }).stdin).length < 8100);
  assert.match((big.input as { stdin: string }).stdin, /truncated/);
  assert.equal(terminalInteraction({ ...params, stdin: "" }, "poll")?.output, "No input sent.");
  for (const patch of [{ stdin: null }, { processId: "" }, { itemId: null }, { stdin: 12 }])
    assert.equal(terminalInteraction({ ...params, ...patch }, "invalid"), null);
});

test("Codex stdio routes terminal interactions, preserves repeats, and ignores other threads and ended turns", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-terminal-"));
  const binary = join(dir, "fake-codex.cjs");
  const oldPath = process.env.CASM_CODEX_PATH;
  const events: ProviderEvent[] = [];
  const fence = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => write({method, params});
createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'thread/start') result = {thread:{id:'thread'}, model:'fake', reasoningEffort:null};
  if (m.method === 'collaborationMode/list' || m.method === 'skills/list') result = {data:[]};
  if (m.method === 'turn/start') result = {turn:{id:'turn',status:'inProgress'}};
  write({id:m.id,result});
  if (m.method !== 'turn/start') return;
  notify('turn/started',{threadId:'thread',turn:{id:'turn'}});
  const command = {type:'commandExecution',id:'shell',processId:'pty-1',command:"/bin/bash -lc 'npm test'",cwd:'/tmp',status:'inProgress'};
  notify('item/started',{threadId:'thread',turnId:'turn',item:command});
  const p = ${JSON.stringify(params)};
  const input = changes => notify('item/commandExecution/terminalInteraction',{...p,...changes});
  input({}); input({}); input({stdin:''});
  input({processId:'unknown',itemId:'other',stdin:'hello'});
  input({threadId:'child'}); input({turnId:'old'}); input({stdin:42});
  notify('item/completed',{threadId:'thread',turnId:'turn',item:{...command,status:'completed',aggregatedOutput:'done'}});
  notify('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  input({stdin:'late'});
  notify('warning',{threadId:'thread',message:'test-fence'});
});
`, { mode: 0o755 });
  process.env.CASM_CODEX_PATH = binary;
  const session = codexProvider().open({
    cwd: dir, config: {}, resumeId: null,
    emit: (e) => {
      events.push(e);
      if (e.type === "item" && e.item.kind === "notice" && e.item.text.includes("test-fence")) fence.resolve();
      if (e.type === "closed") { closed.resolve(); fence.reject(new Error(e.error ?? "unexpected close")); }
    },
    askPermission: async () => { throw new Error("unexpected permission"); },
    askQuestion: async () => { throw new Error("unexpected question"); },
  });
  t.after(async () => {
    await session.close();
    await closed.promise;
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH;
    else process.env.CASM_CODEX_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("run tests", "user-1");
  await fence.promise;
  const tools = events.flatMap((e) => e.type === "item" && e.item.kind === "tool" ? [e.item] : []);
  const inputs = tools.filter((item) => item.name === "terminal");
  assert.equal(inputs.length, 4);
  assert.equal(new Set(inputs.map((item) => item.id)).size, 4);
  assert.deepEqual(inputs.slice(0, 2).map((item) => (item.input as { stdin: string }).stdin), ["yes\n", "yes\n"]);
  assert.equal((inputs[0].input as { command: string }).command, "npm test");
  assert.equal((inputs[3].input as { command?: string }).command, undefined);
  assert.deepEqual(tools.filter((item) => item.id === "shell").map((item) => item.status), ["running", "done"]);
  assert.equal(events.filter((e) => e.type === "turnEnded").length, 1);
});

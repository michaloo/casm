import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../src/providers/diagnostics.ts";
import { codexProvider, nativeMode, subagentItems } from "../src/providers/codex.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import { mergeHistorySupplements } from "../src/history-supplements.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const run = { id: "hook", eventName: "preToolUse", handlerType: "command", executionMode: "sync", sourcePath: "/hooks/check", status: "running", entries: [] };
const codexFixtures = [
  ["item/plan/delta", { itemId: "plan", delta: "First " }],
  ["item/plan/delta", { itemId: "plan", delta: "step" }],
  ["thread/goal/updated", { goal: { objective: "Cover adapters", status: "active", tokenBudget: 1000, tokensUsed: 23, timeUsedSeconds: 5 } }],
  ["thread/goal/cleared", {}],
  ["modelProvider/authRecoveryStarted", { provider: "openai", message: "Refreshing" }],
  ["modelProvider/authRecoveryCompleted", { provider: "openai", message: "Recovered" }],
  ["hook/started", { run }],
  ["hook/completed", { run: { ...run, status: "blocked", statusMessage: "Policy blocked", entries: [{ kind: "error", text: "failed check" }, { kind: "context", text: "HIDDEN" }] } }],
] as const;
const claudeFixtures = [
  { type: "auth_status", isAuthenticating: true, output: ["Refreshing"] },
  { type: "auth_status", isAuthenticating: false, output: [], error: "Invalid token" },
  { type: "system", subtype: "hook_started", hook_id: "hook", hook_name: "check", hook_event: "PreToolUse" },
  { type: "system", subtype: "hook_progress", hook_id: "hook", hook_name: "check", hook_event: "PreToolUse", stdout: "working", stderr: "warning", output: "progress" },
  { type: "system", subtype: "hook_response", hook_id: "hook", hook_name: "check", hook_event: "PreToolUse", stdout: "", stderr: "failed check", output: "blocked", exit_code: 2, outcome: "error" },
];

test("diagnostics preserve stable rows, failures and hidden context boundaries", () => {
  const d = new Diagnostics();
  const rows = codexFixtures.map(([method, p]) => d.codex(method, { threadId: "parent", turnId: "turn", ...p })!);
  assert.equal(rows[0].id, rows[1].id);
  assert.ok(rows[1].kind === "assistant" && rows[1].text === "First step");
  assert.ok(rows[2].kind === "notice" && rows[2].text.includes("23 / 1000"));
  assert.equal(rows[2].id, rows[3].id);
  assert.equal(rows[4].id, rows[5].id);
  assert.equal(rows[6].id, rows[7].id);
  assert.ok(rows[7].kind === "tool" && rows[7].status === "error" && rows[7].output?.includes("failed check"));
  assert.ok(!JSON.stringify(rows).includes("HIDDEN"));
  assert.equal(d.codex("hook/started", { run }), null);
  const c = claudeFixtures.map(m => d.claude({ session_id: "s", ...m })!);
  assert.equal(c[0].id, c[1].id);
  assert.ok(c[1].kind === "notice" && c[1].level === "error");
  assert.ok(c[4].kind === "tool" && c[4].status === "error" && c[4].output?.includes("stderr: failed check"));
  const stale = mergeHistorySupplements([], [{ item: rows[6] }])[0];
  assert.ok(stale.kind === "tool" && stale.output?.includes("Final outcome") && !stale.output.includes("Approval"));
  assert.deepEqual(mergeHistorySupplements([rows[1]], [{ item: rows[0] }]), [rows[1]]);
});

test("native settings map only known presets and child metadata survives activity updates", () => {
  const settings = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false }, activePermissionProfile: null, approvalsReviewer: "user", collaborationMode: { mode: "plan" } };
  assert.equal(nativeMode(settings, "plan"), "plan");
  assert.equal(nativeMode({ ...settings, approvalPolicy: "untrusted" }, "plan"), undefined);
  const child = subagentItems({ type: "collabAgentToolCall", id: "call", receiverThreadIds: ["child"], model: "gpt-6", reasoningEffort: "high", agentsStates: {} })[0];
  assert.equal(child.model, "gpt-6");
  assert.equal(subagentItems({ type: "subAgentActivity", id: "a", agentThreadId: "child", kind: "completed" }, new Map([["child", child]]))[0].effort, "high");
});

for (const provider of ["codex", "claude"] as const) test(`${provider} diagnostic transport retains events and isolates child messages`, { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "casm-diagnostics-"));
  const binary = join(dir, "fake.cjs");
  const envKey = provider === "codex" ? "CASM_CODEX_PATH" : "CASM_CLAUDE_PATH";
  const previous = process.env[envKey];
  const events: ProviderEvent[] = [];
  const requests: unknown[] = [];
  const done = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const messages = provider === "codex" ? codexFixtures.flatMap(([method, p]) => [
    { method, params: { threadId: "parent", turnId: "turn", ...p } },
    { method, params: { threadId: "child", turnId: "turn", ...p, itemId: "private", run: { ...run, id: "private" } } },
  ]) : claudeFixtures.flatMap((m, i) => [{ ...m, uuid: `event${i}`, session_id: "parent" }, { ...m, uuid: `private${i}`, session_id: "parent", parent_tool_use_id: "child" }]);
  writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (${JSON.stringify(provider)} === 'codex') {
  if (m.id === undefined || !m.method) return;
  let result = {};
  if(m.method==='thread/start') result={thread:{id:'parent'},model:'fake'};
  if(m.method==='skills/list'||m.method==='collaborationMode/list') result={data:[]};
  if(m.method==='turn/start') result={turn:{id:'turn',status:'inProgress'}};
  write({id:m.id,result}); if(m.method!=='turn/start') return;
  for(const event of ${JSON.stringify(messages)}) write(event);
  write({method:'item/completed',params:{threadId:'parent',item:{type:'plan',id:'plan',text:'Final plan'}}});
  write({method:'item/plan/delta',params:{threadId:'parent',itemId:'plan',delta:'STALE'}});
  for (const [id, executionMode] of [['abandoned','sync'],['background','async']]) write({method:'hook/started',params:{threadId:'parent',turnId:'turn',run:{id,eventName:'stop',status:'running',executionMode,entries:[]}}});
  write({method:'item/started',params:{threadId:'parent',item:{type:'hookPrompt',id:'secret',text:'HIDDEN'}}});
  write({method:'thread/settings/updated',params:{threadId:'parent',threadSettings:{effort:'high',model:'fake'}}});
  write({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'parent',turnId:'turn',itemId:'cmd',kind:'writeStdin',command:'yes',networkApprovalContext:{host:'example.com',protocol:'https'}}});
  write({method:'turn/completed',params:{threadId:'parent',turn:{id:'turn',status:'interrupted'}}});
 } else {
  if(m.type==='control_request') write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if(m.type!=='user') return;
  for(const event of ${JSON.stringify(messages)}) write(event);
  write({type:'system',subtype:'commands_changed',uuid:'changed',session_id:'parent'});
 }
});`, { mode: 0o755 });
  process.env[envKey] = binary;
  const session = (provider === "codex" ? codexProvider() : claudeProvider()).open({ cwd: dir, config: {}, resumeId: null,
    emit: e => { events.push(e); if (e.type === "turnEnded" || e.type === "commandsChanged") done.resolve(); if (e.type === "closed") { closed.resolve(); done.reject(new Error(e.error ?? "closed")); } },
    askQuestion: async () => null, askPermission: async req => { requests.push(req); return { decision: "deny" }; },
  });
  t.after(async () => { await session.close(); if (previous === undefined) delete process.env[envKey]; else process.env[envKey] = previous; rmSync(dir, { recursive: true, force: true }); });
  session.send("test", "user");
  await done.promise;
  const rows = events.flatMap(e => e.type === "item" && e.history ? [e.item] : []);
  assert.equal(rows.length, provider === "codex" ? 11 : 5);
  assert.ok(!JSON.stringify(rows).includes("HIDDEN"));
  assert.ok(!rows.some(r => r.id.includes("private")));
  if(provider === "codex") {
    assert.ok(!JSON.stringify(events).includes("STALE"));
    const latest = (id: string) => events.flatMap(e => e.type === "item" && e.item.id === id ? [e.item] : []).at(-1);
    assert.equal(latest("plan")?.kind === "assistant" && (latest("plan") as { text: string }).text, "Final plan");
    assert.equal((latest("hook:abandoned") as { status: string }).status, "error");
    assert.equal((latest("hook:background") as { status: string }).status, "running");
    await session.close(); await closed.promise;
    assert.equal((latest("hook:background") as { status: string }).status, "error");
    assert.match((latest("hook:background") as { output: string }).output, /outcome unknown/);

    assert.ok(events.some(e => e.type === "effort" && e.effort === "high"));
    assert.match(JSON.stringify(requests), /writeStdin/);
    assert.match(JSON.stringify(requests), /example.com/);
  }
});

test("manager invalidates commands and persists native effort without losing diagnostics", async () => {
  const { Store } = await import("../src/db.ts");
  const { AgentManager } = await import("../src/agents.ts");
  const dir = mkdtempSync(join(tmpdir(), "casm-diagnostic-manager-"));
  const store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "test", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: dir, config: { effort: "low" } });
  let calls = 0;
  const provider: import("../src/providers/types.ts").Provider = {
    id: "claude", async history() { return []; }, async catalog() { return { models: [], modes: [] }; }, async commands() { calls++; return []; }, async usage() { return null; },
    open(o) { o.emit({ type: "sessionId", id: "native" }); return { send() {
      o.emit({ type: "commandsChanged" }); o.emit({ type: "effort", effort: "high" });
      const d = new Diagnostics();
      for (const m of claudeFixtures) o.emit({ type: "item", item: d.claude({ ...m, session_id: "native" })!, history: {} });
      setImmediate(() => o.emit({ type: "turnEnded", outcome: "completed" }));
    }, shell() {}, async interrupt() {}, async close() {} }; },
  };
  const manager = new AgentManager(store, new Map([["claude", provider]]), () => {});
  try {
    await manager.commands(agent.id); await manager.commands(agent.id); assert.equal(calls, 1);
    manager.send(agent.id, { text: "test" }); await manager.wait(agent.id);
    await manager.commands(agent.id); assert.equal(calls, 2);
    assert.equal(store.getAgent(agent.id)?.config.effort, "high");
    const items = (await manager.history(agent.id)).items;
    assert.equal(items.length, 2);
    assert.ok(items.some(i => i.kind === "tool" && i.status === "error" && i.output?.includes("stderr: failed check")));
  } finally { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("final plan rejects late deltas; abandoned hooks are unknown while async hooks survive turns", () => {
  const d = new Diagnostics();
  d.codex("item/plan/delta", { itemId: "p", delta: "draft" });
  d.codex("item/completed", { item: { type: "plan", id: "p", text: "Final plan" } });
  assert.equal(d.codex("item/plan/delta", { itemId: "p", delta: "late" }), null);
  for (const [id, executionMode, turnId] of [["sync", "sync", "t"], ["async", "async", "t"], ["thread", "sync", null], ["other", "sync", "other"]])
    d.codex("hook/started", { turnId, run: { ...run, id, executionMode } });
  const abandoned = d.finishHooks("t");
  assert.deepEqual(abandoned.map(i => i.id), ["hook:sync"]);
  assert.ok(abandoned[0].kind === "tool" && abandoned[0].status === "error" && abandoned[0].output?.includes("outcome unknown"));
  assert.equal(d.codex("hook/started", { turnId: "t", run: { ...run, id: "sync" } }), null);
  const closed = d.finishHooks();
  assert.deepEqual(closed.map(i => i.id), ["hook:async", "hook:thread", "hook:other"]);
  assert.deepEqual(d.finishHooks(), []);
});

test("native mode refuses custom filesystem policies and never promotes auto to overrides", () => {
  const policy = { type: "workspaceWrite", networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const settings = { approvalPolicy: "on-request", sandboxPolicy: policy, activePermissionProfile: null, approvalsReviewer: "auto_review", collaborationMode: { mode: "default" } };
  assert.equal(nativeMode(settings, "auto-review"), "auto-review");
  for (const mode of [undefined, "auto", "default"]) assert.equal(nativeMode(settings, mode), undefined);
  for (const patch of [{ networkAccess: true }, { writableRoots: ["/extra"] }, { excludeTmpdirEnvVar: true }, { excludeSlashTmp: true }])
    assert.equal(nativeMode({ ...settings, sandboxPolicy: { ...policy, ...patch } }, "auto-review"), undefined);
  assert.equal(nativeMode({ ...settings, activePermissionProfile: { id: "custom", extends: null } }, "auto-review"), undefined);
});

for (const ending of ["close", "crash"] as const) test(`Claude unfinished hooks survive result and become unknown on ${ending}`, { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-hook-exit-"));
  const binary = join(dir, "fake.cjs");
  const previous = process.env.CASM_CLAUDE_PATH;
  const events: ProviderEvent[] = [];
  const result = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.type==='control_request') write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
 if(m.type!=='user') return;
 for(const hook_id of ['unfinished','finished']) write({type:'system',subtype:'hook_started',hook_id,hook_name:'check',hook_event:'Stop',uuid:hook_id,session_id:'parent'});
 write({type:'system',subtype:'hook_progress',hook_id:'unfinished',hook_name:'check',hook_event:'Stop',stdout:'working',stderr:'warning',output:'',uuid:'progress',session_id:'parent'});
 write({type:'system',subtype:'hook_response',hook_id:'finished',hook_name:'check',hook_event:'Stop',stdout:'done',stderr:'',output:'',outcome:'success',exit_code:0,uuid:'finished-result',session_id:'parent'});
 write({type:'result',subtype:'success',is_error:false,result:'done',total_cost_usd:0,modelUsage:{},uuid:'result',session_id:'parent'});
 if(${JSON.stringify(ending)}==='crash') setTimeout(()=>process.exit(7),150);
});`, { mode: 0o755 });
  process.env.CASM_CLAUDE_PATH = binary;
  const session = claudeProvider().open({ cwd: dir, config: {}, resumeId: null,
    emit: e => { events.push(e); if (e.type === "turnEnded") result.resolve(); if (e.type === "closed") { closed.resolve(); result.reject(new Error(e.error ?? "closed before result")); } },
    askQuestion: async () => null, askPermission: async () => ({ decision: "deny" }),
  });
  t.after(async () => { await session.close(); if (previous === undefined) delete process.env.CASM_CLAUDE_PATH; else process.env.CASM_CLAUDE_PATH = previous; rmSync(dir, { recursive: true, force: true }); });
  session.send("test", "user");
  await result.promise;
  const rows = (id: string) => events.flatMap(e => e.type === "item" && e.item.kind === "tool" && e.item.id === `hook:${id}` ? [{ item: e.item, history: e.history }] : []);
  assert.equal(rows("unfinished").at(-1)?.item.status, "running");
  if (ending === "close") await session.close();
  await closed.promise;
  const unfinished = rows("unfinished");
  assert.equal(unfinished.length, 3);
  assert.equal(unfinished.at(-1)?.item.status, "error");
  assert.match(unfinished.at(-1)!.item.output!, /stderr: warning[\s\S]*outcome unknown/);
  assert.deepEqual(unfinished.at(-1)?.history, {});
  assert.equal(rows("finished").length, 2);
  assert.equal(rows("finished").at(-1)?.item.status, "done");
  const closedIndex = events.findIndex(e => e.type === "closed");
  assert.ok(events.slice(0, closedIndex).some(e => e.type === "item" && e.item.kind === "tool" && e.item.id === "hook:unfinished" && e.item.status === "error"));
});

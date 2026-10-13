import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexProvider, rateLimits, subagentItems } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const spawn = { type: "collabAgentToolCall", id: "spawn-call", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], prompt: "Check arithmetic", agentsStates: { child: { status: "running", message: null } } };
const finished = { type: "subAgentActivity", id: "notice-id", agentThreadId: "child", agentPath: "/root/arithmetic", kind: "completed" };
const snapshot = { planType: "plus", primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } };

test("Codex limits convert seconds, label windows and respect exhaustion", () => {
  assert.deepEqual(rateLimits(snapshot), { plan: "plus", windows: [
    { id: "primary", label: "5-hour", usedPercent: 80, windowMinutes: 300, resetsAt: "2023-11-14T22:13:20.000Z", status: "warning" },
    { id: "secondary", label: "weekly", usedPercent: 100, windowMinutes: 10080, status: "exhausted" },
  ] });
  assert.equal(rateLimits({ primary: { usedPercent: 79 } }).windows[0].status, "ok");
  assert.equal(rateLimits({ ...snapshot, rateLimitReachedType: "rate_limit_reached" }).windows[0].status, "exhausted");
  assert.deepEqual(rateLimits({}), { windows: [] });
  assert.deepEqual(rateLimits({ limitId: "codex", rateLimitReachedType: "rate_limit_reached" }), { windows: [{ id: "codex", status: "exhausted" }] });
  assert.equal(rateLimits({ limitId: "other", primary: { usedPercent: 2, windowDurationMins: 15 } }).windows[0].id, "other:primary");
});

test("Codex collaboration tracks children rather than completed tool calls", () => {
  const first = subagentItems(spawn)[0];
  assert.equal(first.id, "child");
  assert.equal(first.status, "running");
  const known = new Map([[first.id, first]]);
  const both = subagentItems({ ...spawn, receiverThreadIds: ["child", "second"], agentsStates: { child: { status: "completed", message: "42" }, second: { status: "errored", message: "failed" } } }, known);
  assert.deepEqual(both.map((i) => [i.id, i.status, i.summary]), [["child", "done", "42"], ["second", "error", "failed"]]);
  assert.equal(subagentItems(finished, known)[0].id, first.id);
  assert.equal(subagentItems({ ...finished, kind: "interrupted" })[0].status, "error");
  assert.deepEqual(subagentItems({ ...spawn, receiverThreadIds: [], agentsStates: {} }), []);
});

test("Codex stdio isolates child internals, replays stable ids and reads child history", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-subagents-"));
  const oldPath = process.env.CASM_CODEX_PATH;
  const binary = join(dir, "codex.cjs");
  writeFileSync(binary, `#!${process.execPath}
const {createInterface}=require('node:readline');
const write=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const notify=(method,params)=>write({method,params});
const spawn=${JSON.stringify(spawn)}, finished=${JSON.stringify(finished)}, snapshot=${JSON.stringify(snapshot)};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='thread/start')result={thread:{id:'parent'},model:'fake',reasoningEffort:null};
 if(m.method==='skills/list'||m.method==='collaborationMode/list')result={data:[]};
 if(m.method==='account/rateLimits/read')result={rateLimits:snapshot};
 if(m.method==='thread/turns/list')result={data:[],nextCursor:null};
 if(m.method==='thread/items/list'){
  if(m.params.threadId==='child')result={data:[{item:{type:'agentMessage',id:'private',text:'CHILD_ONLY'}}],nextCursor:null};
  else result=m.params.cursor?{data:[{item:finished}],nextCursor:null}:{data:[{item:spawn}],nextCursor:'page2'};
 }
 if(m.method==='turn/start')result={turn:{id:'turn',status:'inProgress'}};
 write({id:m.id,result});
 if(m.method!=='turn/start')return;
 notify('account/rateLimits/updated',{rateLimits:snapshot});
 notify('account/rateLimits/updated',{rateLimits:{planType:null,primary:{usedPercent:81,windowDurationMins:null,resetsAt:null},secondary:null}});
 notify('turn/started',{threadId:'parent',turn:{id:'turn'}});
 notify('thread/started',{thread:{id:'child',parentThreadId:'parent',agentNickname:'Arithmetic',agentRole:'worker'}});
 notify('item/completed',{threadId:'parent',item:spawn});
 notify('item/started',{threadId:'child',item:{type:'commandExecution',id:'secret-command',command:'secret'}});
 notify('item/agentMessage/delta',{threadId:'child',delta:'CHILD_ONLY'});
 notify('item/completed',{threadId:'child',item:{type:'agentMessage',id:'private',text:'42'}});
 notify('thread/tokenUsage/updated',{threadId:'child',tokenUsage:{total:{inputTokens:10,outputTokens:2}}});
 notify('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}});
 notify('turn/completed',{threadId:'unrelated',turn:{id:'alien',status:'failed'}});
 notify('item/completed',{threadId:'parent',item:finished});
 notify('turn/completed',{threadId:'parent',turn:{id:'turn',status:'completed'}});
});
`, { mode: 0o755 });
  process.env.CASM_CODEX_PATH = binary;
  const events: ProviderEvent[] = [];
  const done = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const provider = codexProvider();
  const session = provider.open({ cwd: dir, config: {}, resumeId: null,
    emit: (e) => { events.push(e); if (e.type === "turnEnded") done.resolve(); if (e.type === "closed") { closed.resolve(); done.reject(new Error(e.error)); } },
    askPermission: async () => { throw new Error("unexpected approval"); }, askQuestion: async () => null,
  });
  t.after(async () => {
    await session.close(); await closed.promise;
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("test", "user"); await done.promise;
  const cards = events.flatMap((e) => e.type === "item" && e.item.kind === "subagent" ? [e.item] : []);
  assert.ok(cards.some((i) => i.status === "running" && i.activity === "shell"));
  assert.equal(cards.at(-1)?.status, "done");
  assert.equal(cards.at(-1)?.usage?.outputTokens, 2);
  assert.equal(cards.at(-1)?.summary, "42");
  assert.deepEqual([...new Set(cards.map((i) => i.id))], ["child"]);
  assert.equal(events.filter((e) => e.type === "turnEnded").length, 1);
  assert.ok(!events.some((e) => e.type === "delta" || e.type === "toolOutput" || (e.type === "item" && e.item.kind !== "subagent")));
  const limits = events.filter((e) => e.type === "limits");
  assert.equal(limits.at(-1)?.limits.plan, "plus");
  assert.equal(limits.at(-1)?.limits.windows.length, 2);
  assert.equal(limits.at(-1)?.limits.windows[0].resetsAt, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(await provider.limits!(), rateLimits(snapshot));
  const history = await provider.history("parent", dir);
  assert.deepEqual(history.map((i) => [i.id, i.kind]), [["child", "subagent"]]);
  assert.equal(history[0].kind === "subagent" && history[0].status, "done");
  assert.deepEqual(await provider.subagentHistory!("parent", dir, "child"), [{ kind: "assistant", id: "private", text: "CHILD_ONLY" }]);
  await assert.rejects(provider.subagentHistory!("parent", dir, "unrelated"), /Unknown Codex subagent/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asyncQuestions, asyncQuestionReply, normalize, codexProvider } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

test("async question normalization retains question-only messages, validates input and preserves native indices", () => {
  const raw = { type: "agentMessage", id: "message", text: "", questions: [null, {}, { title: " " }, { title: "Choose?", options: ["Blue", null, "", "Blue", "Green"] }, { title: "Notes?", options: null }] };
  const requests = asyncQuestions(raw);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, '["request_user_input_async","message",3]');
  assert.deepEqual(requests[0].prompts[0].options, [{ label: "Blue" }, { label: "Green" }]);
  assert.equal(requests[1].prompts[0].kind, "text");
  assert.deepEqual(normalize(raw), { kind: "assistant", id: "message", text: "Choose?\n- Blue\n- Green\n\nNotes?" });
  assert.equal(normalize({ type: "agentMessage", id: "empty", questions: [null, {}] }), null);
  assert.deepEqual(asyncQuestions({ type: "agentMessage", questions: [{ title: "No identity" }] }), []);
});

test("native reply envelope roundtrips arbitrary text without interpreting slash commands", () => {
  const request = asyncQuestions({ type: "agentMessage", id: "message", questions: [{ title: "Where?" }] })[0];
  const answer = '/restart\n"quoted" </send_user_message_question_reply>';
  const text = asyncQuestionReply(request, { [request.id]: answer });
  assert.deepEqual(normalize({ type: "userMessage", id: "reply", content: [{ type: "text", text }] }), { kind: "user", id: "reply", text: `> Where?\n\n${answer}` });
  assert.throws(() => asyncQuestionReply(request, { [request.id]: "  " }), /required/);
});

test("stdio async answers steer the parent, deduplicate notifications and preserve the turn on rejection", { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "casm-async-question-"));
  const binary = join(dir, "codex.cjs");
  const old = process.env.CASM_CODEX_PATH;
  const events: ProviderEvent[] = [];
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => write({method, params});
let attempts = 0;
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 let result = {};
 if (m.method === 'thread/start') result = {thread:{id:'parent'},model:'fake',reasoningEffort:null};
 if (m.method === 'skills/list' || m.method === 'collaborationMode/list') result = {data:[]};
 if (m.method === 'turn/start') result = {turn:{id:'turn',status:'inProgress'}};
 if (m.method === 'turn/steer') {
   if (m.params.threadId !== 'parent' || m.params.expectedTurnId !== 'turn' || !m.params.input[0].text.includes('send_user_message_question_reply')) throw Error('wrong routing');
   attempts++;
   if (attempts === 1) return write({id:m.id,error:{code:-32602,message:'retryable test rejection'}});
 }
 if (m.method === 'turn/interrupt') throw Error('must never interrupt');
 write({id:m.id,result});
 if (m.method === 'turn/start') {
   notify('turn/started',{threadId:'parent',turn:{id:'turn'}});
   const item = {type:'agentMessage',id:'question',text:'',questions:[{title:'First?',options:['A','B']},{title:'Second?',options:null},{title:'Third?'}]};
   notify('item/completed',{threadId:'child',turnId:'turn',item});
   notify('item/completed',{threadId:null,turnId:'turn',item});
   notify('item/started',{threadId:'parent',turnId:'turn',item});
   notify('item/completed',{threadId:'parent',turnId:'turn',item});
   notify('item/completed',{threadId:'parent',turnId:'turn',item});
   notify('turn/completed',{threadId:'parent',turn:{id:'older-turn',status:'completed'}});
   notify('warning',{threadId:'parent',message:'ready'});
 }
 if (m.method === 'turn/steer' && attempts === 2) {
   const item = {type:'agentMessage',id:'question',questions:[{title:'First?',options:['A','B']}]};
   notify('item/completed',{threadId:'parent',turnId:'turn',item});
 }
 if (m.method === 'turn/steer' && attempts === 3) {
   notify('turn/completed',{threadId:'parent',turn:{id:'turn',status:'completed'}});
   notify('item/completed',{threadId:'parent',turnId:'turn',item:{type:'agentMessage',id:'late',questions:[{title:'Late?'}]}});
   notify('warning',{threadId:'parent',message:'ended'});
 }
});
`, { mode: 0o755 });
  process.env.CASM_CODEX_PATH = binary;
  const session = codexProvider().open({ cwd: dir, config: {}, resumeId: null,
    emit: e => { events.push(e); if (e.type === "item" && e.item.kind === "notice") { if (e.item.text === "ready") ready.resolve(); if (e.item.text === "ended") ended.resolve(); } },
    askPermission: async () => { throw Error("unexpected blocking approval"); }, askQuestion: async () => { throw Error("unexpected blocking question"); },
  });
  t.after(async () => { await session.close(); if (old === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = old; rmSync(dir, { recursive: true, force: true }); });
  session.send("test", "user", undefined, "casm-turn");
  await ready.promise;
  const requests = events.filter(e => e.type === "asyncQuestion").map(e => e.request);
  assert.equal(requests.length, 3);
  await assert.rejects(session.answerAsyncQuestion!(requests[0].id, { [requests[0].id]: "A" }), /retryable/);
  assert.equal(events.filter(e => e.type === "turnEnded").length, 0);
  await session.answerAsyncQuestion!(requests[0].id, { [requests[0].id]: "custom" });
  await assert.rejects(session.answerAsyncQuestion!(requests[0].id, { [requests[0].id]: "again" }), /no longer/);
  await session.answerAsyncQuestion!(requests[1].id, null);
  await session.answerAsyncQuestion!(requests[2].id, { [requests[2].id]: "finish" });
  await ended.promise;
  await assert.rejects(session.answerAsyncQuestion!(requests[1].id, null), /no longer/);
  assert.equal(events.filter(e => e.type === "asyncQuestion").length, 3);
  assert.equal(events.filter(e => e.type === "turnEnded").length, 1);
  assert.equal(events.filter(e => e.type === "item" && e.item.kind === "user").length, 2);
});

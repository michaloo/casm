import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexProvider } from "../src/providers/codex.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

async function until(f: () => boolean) {
  for (const end = Date.now() + 5000; !f(); await new Promise(r => setTimeout(r, 10)))
    if (Date.now() > end) throw new Error("timeout");
}
function fixture(t: TestContext, error = { code: -32600, message: "invalid input" }) {
  const dir = mkdtempSync(join(tmpdir(), "casm-state-"));
  const log = join(dir, "log"); writeFileSync(log, "");
  const binary = join(dir, "codex.cjs");
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const write = m => process.stdout.write(JSON.stringify(m)+'\\n');
let count = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({...m,home:process.env.CODEX_HOME})+'\\n');
 let result = {};
 if(m.method === 'thread/start' || m.method === 'thread/resume') result={thread:{id:'same'},model:'test',reasoningEffort:'medium'};
 if(m.method === 'skills/list') result={data:[{skills:[{name:process.env.CODEX_HOME,description:'scoped',path:'/skill',enabled:true}]}]};
 if(m.method === 'collaborationMode/list') result={data:[]};
 if(m.method === 'thread/items/list') result={data:[{item:{type:'agentMessage',id:'same',text:process.env.CODEX_HOME}}],nextCursor:null};
 if(m.method === 'thread/turns/list') result={data:[],nextCursor:null};
 if(m.method === 'turn/steer' && ${JSON.stringify(error.message)} === 'disconnect') return process.exit(2);
 if(m.method === 'turn/steer') return write({id:m.id,error:${JSON.stringify(error)}});
 if(m.method === 'turn/start') { count++; result={turn:{id:'turn'+count,status:'inProgress'}}; }
 write({id:m.id,result});
 if(m.method === 'turn/start') write({method:'turn/started',params:{threadId:'same',turn:result.turn}});
});
`, { mode: 0o755 });
  const old = process.env.CASM_CODEX_PATH; process.env.CASM_CODEX_PATH = binary;
  t.after(() => { if(old === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH=old; rmSync(dir,{recursive:true,force:true}); });
  return { dir, requests: () => readFileSync(log,"utf8").trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
}

test("Codex same IDs/cwd use independent homes for history, usage, commands and resume", async t => {
  const f = fixture(t), p = codexProvider();
  const original = process.env.CODEX_HOME;
  for(const label of ['one','two']) {
    const home=join(f.dir,label), context={env:{CODEX_HOME:home}};
    mkdirSync(join(home,'sessions'),{recursive:true});
    writeFileSync(join(home,'sessions','rollout-date-same.jsonl'), JSON.stringify({type:'turn_context',payload:{model:label}}));
    assert.equal((await p.history('same',f.dir,context))[0].kind,'assistant');
    assert.equal((await p.history('same',f.dir,context)).find(i=>i.kind==='assistant')?.text,home);
    assert.equal((await p.usage('same',f.dir,context))?.model,label);
    assert.ok((await p.commands(f.dir,context)).some(c=>c.name===home));
    const events:ProviderEvent[]=[];
    const session=p.open({cwd:f.dir,config:context,resumeId:'same',emit:e=>events.push(e),askPermission:async()=>({decision:'deny'}),askQuestion:async()=>null});
    try {session.send('continue','u'); await until(()=>f.requests().some(r=>r.method==='turn/start'&&r.home===home));
      assert.ok(f.requests().some(r=>r.method==='thread/resume'&&r.home===home));
      assert.ok(!events.some(e=>e.type==='closed'));
    } finally {await session.close();}
  }
  assert.equal(process.env.CODEX_HOME,original);
});

for(const error of [
  {code:-32600,message:'invalid input'},
  {code:-32603,message:'transport unavailable'},
  {code:-32600,message:'expected active turn id `old` but found `new`'},
  {code:-32600,message:'no active turn to steer'},
  {code:-32603,message:'no active turn to steer'},
]) test(`Codex steer ${error.code}: ${error.message}`,async t=>{
 const f=fixture(t,error), events:ProviderEvent[]=[];
 const session=codexProvider().open({cwd:f.dir,config:{},resumeId:null,emit:e=>events.push(e),askPermission:async()=>({decision:'deny'}),askQuestion:async()=>null});
 try {
  session.send('initial','u1',undefined,'owner');
  await until(()=>f.requests().some(r=>r.method==='turn/start'));
  await new Promise(r=>setTimeout(r,30));
  session.send('steer','u2',undefined,'owner');
  const race=error.code===-32600&&error.message==='no active turn to steer';
  await until(()=>race?f.requests().filter(r=>r.method==='turn/start').length===2:events.some(e=>e.type==='sendFailed'));
  assert.equal(f.requests().filter(r=>r.method==='turn/start').length,race?2:1);
  assert.ok(!events.some(e=>e.type==='turnEnded'));
  if(!race) assert.deepEqual(events.find(e=>e.type==='sendFailed'),{type:'sendFailed',itemId:'u2',error:error.message});
 } finally {await session.close();}
});

test('Claude custom stores isolate same session and child IDs and permit resume',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'casm-claude-state-'));
 const binary=join(dir,'claude.cjs');
 writeFileSync(binary,`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGS_FILE,JSON.stringify(process.argv));\n`,{mode:0o755});
 const old=process.env.CASM_CLAUDE_PATH, original=process.env.CLAUDE_CONFIG_DIR;process.env.CASM_CLAUDE_PATH=binary;
 t.after(()=>{if(old===undefined) delete process.env.CASM_CLAUDE_PATH;else process.env.CASM_CLAUDE_PATH=old;rmSync(dir,{recursive:true,force:true});});
 const p=claudeProvider(), id='11111111-1111-4111-8111-111111111111';
 for(const label of ['one','two']) {
  const home=join(dir,label), project=join(home,'projects',dir.replace(/[^a-zA-Z0-9]/g,'-'));
  mkdirSync(join(project,id,'subagents'),{recursive:true});
  const line={type:'assistant',uuid:'same',parentUuid:null,message:{role:'assistant',content:[{type:'text',text:label}]}};
  writeFileSync(join(project,id+'.jsonl'),JSON.stringify(line)+'\n'+JSON.stringify({type:'cost-state',modelUsage:{test:{inputTokens:1}},totalCostUSD:label==='one'?1:2}));
  writeFileSync(join(project,id,'subagents','agent-child.jsonl'),JSON.stringify(line));
  const context={env:{CLAUDE_CONFIG_DIR:home,ARGS_FILE:join(home,'args')}};
  assert.equal((await p.history(id,dir,context)).find(i=>i.kind==='assistant')?.text,label);
  assert.equal((await p.usage(id,dir,context))?.costUsd,label==='one'?1:2);
  assert.equal((await p.subagentHistory!(id,dir,'child',context)).find(i=>i.kind==='assistant')?.text,label);
  const closed=Promise.withResolvers<void>();
  const s=p.open({cwd:dir,config:context,resumeId:id,emit:e=>{if(e.type==='closed')closed.resolve();},askPermission:async()=>({decision:'deny'}),askQuestion:async()=>null});
  try {s.send('continue','user');await closed.promise;
   const args:string[]=JSON.parse(readFileSync(context.env.ARGS_FILE,'utf8'));
   assert.ok(args.includes('--resume')?args[args.indexOf('--resume')+1]===id:args.includes('--resume='+id));
  }finally {await s.close();}
 }
 assert.equal(process.env.CLAUDE_CONFIG_DIR,original);
});

test('manager scopes cached commands and all history/usage readers by agent context, including past sessions', async t => {
 const {Store}=await import('../src/db.ts');
 const {AgentManager}=await import('../src/agents.ts');
 const dir=mkdtempSync(join(tmpdir(),'casm-manager-state-')), store=new Store(join(dir,'db'));
 const calls:string[]=[];
 const provider:import('../src/providers/types.ts').Provider={id:'codex',open(){throw new Error('unused');},async catalog(){return{models:[],modes:[]};},
  async commands(_cwd,c){calls.push('commands:'+c?.env?.CODEX_HOME);return[{name:c!.env!.CODEX_HOME,kind:'command'}];},
  async history(id,_cwd,c){calls.push('history:'+id+':'+c?.env?.CODEX_HOME);return[{id,kind:'assistant',text:c!.env!.CODEX_HOME}];},
  async historyAliases(_id,_cwd,c){calls.push('aliases:'+c?.env?.CODEX_HOME);return{};},
  async usage(_id,_cwd,c){return{model:c?.env?.CODEX_HOME};},
  async subagentHistory(_id,_cwd,child,c){return[{id:child,kind:'assistant',text:c!.env!.CODEX_HOME}];},
 };
 const manager=new AgentManager(store,new Map([['codex',provider]]),()=>{});
 t.after(async()=>{await manager.shutdown();store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({name:'p',path:dir});
 for(const home of ['one','two']) {
  const a=store.createAgent({projectId:project.id,name:home,provider:'codex',cwd:dir,config:{env:{CODEX_HOME:home}}});
  store.updateAgent(a.id,{nativeSessionId:'same'});store.addPastSession(a.id,'past');
  assert.equal((await manager.commands(a.id))[0].name,home);
  await manager.commands(a.id);
  assert.equal((await manager.usage(a.id))?.model,home);
  assert.deepEqual((await manager.history(a.id)).items.filter(i=>i.kind==='assistant').map(i=>i.text),[home,home]);
  assert.equal((await manager.subagentHistory(a.id,'past0:child')).find(i=>i.kind==='assistant')?.text,home);
 }
 assert.deepEqual(calls.filter(c=>c.startsWith('commands:')),['commands:one','commands:two']);
 assert.ok(calls.includes('history:past:one')&&calls.includes('history:past:two'));
});

test('Codex disconnected steer never starts duplicate input', async t=>{
 const f=fixture(t,{code:0,message:'disconnect'}),events:ProviderEvent[]=[];
 const session=codexProvider().open({cwd:f.dir,config:{},resumeId:null,emit:e=>events.push(e),askPermission:async()=>({decision:'deny'}),askQuestion:async()=>null});
 try {
  await session.send('initial','u1');
  await session.send('steer','u2');
  assert.ok(events.some(e=>e.type==='closed'));
  assert.equal(f.requests().filter(r=>r.method==='turn/start').length,1);
 } finally {await session.close();}
});

test('Claude command lookup and context-window cache use per-agent environment',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'casm-claude-idle-state-')), binary=join(dir,'claude.cjs'),log=join(dir,'log');
 writeFileSync(log,'');
 writeFileSync(binary,`#!${process.execPath}
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},process.env.CLAUDE_CONFIG_DIR+'\\n');
const write=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.type!=='control_request')return;
 let response={commands:[{name:process.env.CLAUDE_CONFIG_DIR,description:'scoped',argumentHint:''}],skills:[]};
 if(m.request.subtype==='get_context_usage')response={rawMaxTokens:Number(process.env.WINDOW),categories:[],totalTokens:0,maxTokens:1,percentage:0,gridRows:[],memoryFiles:[],mcpTools:[],agents:[]};
 write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
});`,{mode:0o755});
 const old=process.env.CASM_CLAUDE_PATH;process.env.CASM_CLAUDE_PATH=binary;
 t.after(()=>{if(old===undefined)delete process.env.CASM_CLAUDE_PATH;else process.env.CASM_CLAUDE_PATH=old;rmSync(dir,{recursive:true,force:true});});
 const p=claudeProvider();
 for(const value of [100,200]) {
  const home=join(dir,String(value)), project=join(home,'projects',dir.replace(/[^a-zA-Z0-9]/g,'-'));
  mkdirSync(project,{recursive:true});
  writeFileSync(join(project,'same.jsonl'),JSON.stringify({type:'assistant',uuid:'same',message:{model:'same-model',usage:{input_tokens:1},content:[]}}));
  const context={env:{CLAUDE_CONFIG_DIR:home,WINDOW:String(value)}};
  assert.ok((await p.commands(dir,context)).some(c=>c.name===home));
  assert.equal((await p.usage('same',dir,context))?.contextWindow,value);
  assert.equal((await p.usage('same',dir,context))?.contextWindow,value);
 }
 assert.equal(readFileSync(log,'utf8').trim().split('\n').length,4);
});

test('new restart records retain only store home across configuration changes and DB reopen', async t=>{
 const {Store}=await import('../src/db.ts'),{AgentManager}=await import('../src/agents.ts');
 const dir=mkdtempSync(join(tmpdir(),'casm-restart-state-')),file=join(dir,'db');
 let store=new Store(file);
 const providers=new Map<import('@casm/protocol').ProviderId,import('../src/providers/types.ts').Provider>();
 for(const id of ['codex','claude'] as const)providers.set(id,{id,open(){throw new Error('unused');},async catalog(){return{models:[],modes:[]};},async commands(){return[];},async usage(){return null;},
  async history(_id,_cwd,c){return[{kind:'assistant',id:'same',text:JSON.stringify(c?.env)}];},
  async subagentHistory(_id,_cwd,_child,c){return[{kind:'assistant',id:'child',text:JSON.stringify(c?.env)}];},
 });
 let manager=new AgentManager(store,providers,()=>{});
 const agents:string[]=[];
 try {
  const p=store.createProject({name:'p',path:dir});
  for(const provider of ['codex','claude'] as const){
   const key=provider==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR';
   const a=store.createAgent({projectId:p.id,name:provider,provider,cwd:dir,config:{env:{[key]:'old-home',API_SECRET:'do-not-snapshot'}}});agents.push(a.id);
   store.updateAgent(a.id,{nativeSessionId:'same'});
   await manager.restart(a.id);
   assert.deepEqual(store.pastSessions(a.id)[0].context,{env:{[key]:'old-home'}});
   store.updateAgent(a.id,{config:{env:{[key]:'new-home'}}});
  }
  await manager.shutdown();store.close();store=new Store(file);manager=new AgentManager(store,providers,()=>{});
  for(const id of agents){
   const history=(await manager.history(id)).items.find(i=>i.kind==='assistant');
   assert.ok(history?.text.includes('old-home'));
   assert.ok(!history?.text.includes('do-not-snapshot'));
   assert.ok((await manager.subagentHistory(id,'past0:child')).find(i=>i.kind==='assistant')?.text.includes('old-home'));
  }
 } finally {await manager.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
});

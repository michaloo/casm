import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexProvider } from "../src/providers/codex.ts";
import type { PermissionRequest } from "@casm/protocol";
import type { PermissionAnswer, ProviderEvent } from "../src/providers/types.ts";

// Exercises actual newline-delimited app-server requests/responses, beyond the
// existing URL elicitation and automatic-review normalizer tests. Fixtures use
// installed 0.160.1 v2 approval schemas; no real commands/files/network run.
type Kind = "command" | "writeStdin" | "file" | "permissions";
type Answer = "allow" | "allowAlways" | "deny" | "cancel";
const permissions = { network: { enabled: true }, fileSystem: { read: ["/sandbox/read"], write: ["/sandbox/write"] } };
const networkApprovalContext = { host: "example.test", protocol: "https" };
type RpcRequest = { id: string; method: string; params: Record<string, unknown> };
function request(kind: Kind, id = "approval", threadId = "parent"): RpcRequest {
  const base = { threadId, turnId: "turn", itemId: "tool", startedAtMs: 1700000000000 };
  if (kind === "file") return { id, method: "item/fileChange/requestApproval", params: { ...base, reason: "Apply patch", grantRoot: "/sandbox" } };
  if (kind === "permissions") return { id, method: "item/permissions/requestApproval", params: { ...base, environmentId: null, cwd: "/sandbox", reason: "Need access", permissions } };
  return { id, method: "item/commandExecution/requestApproval", params: {
    ...base, kind, approvalId: id, environmentId: null,
    command: kind === "writeStdin" ? "yes\\n" : "curl https://example.test", cwd: "/sandbox", reason: "Network operation",
    networkApprovalContext, proposedExecpolicyAmendment: ["curl"],
    proposedNetworkPolicyAmendments: [{ host: "example.test", action: "allow" }],
  } };
}
async function until(ready: () => boolean) {
  for (const deadline = Date.now() + 5000; !ready(); await new Promise(r => setTimeout(r, 10)))
    if (Date.now() > deadline) throw new Error("timed out waiting for approval RPC response");
}
async function fixture(t: TestContext, requests: RpcRequest[], options: {
  answer?: Answer;
  answerFor?: (req: PermissionRequest) => Answer;
  afterRequests?: "complete" | "resolve";
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-approvals-"));
  const binary = join(dir, "codex.cjs"), log = join(dir, "responses.jsonl");
  writeFileSync(log, "");
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => write({method,params});
const requests = ${JSON.stringify(requests)};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === undefined && m.id !== undefined) {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m)+'\\n');
  return;
 }
 if (m.id === undefined) return;
 let result = {};
 if (m.method === 'thread/start') result={thread:{id:'parent'},model:'test',reasoningEffort:null};
 if (m.method === 'skills/list' || m.method === 'collaborationMode/list') result={data:[]};
 if (m.method === 'turn/start') result={turn:{id:'turn',status:'inProgress'}};
 write({id:m.id,result});
 if (m.method !== 'turn/start') return;
 notify('turn/started',{threadId:'parent',turn:{id:'turn',status:'inProgress'}});
 notify('item/started',{threadId:'parent',turnId:'turn',item:{type:'fileChange',id:'tool',status:'inProgress',changes:[{path:'/sandbox/file.txt',kind:{type:'update'},diff:'-old\\n+new'}]}});
 for(const req of requests) write(req);
 if(${JSON.stringify(options.afterRequests)} === 'complete')
  setTimeout(()=>notify('turn/completed',{threadId:'parent',turn:{id:'turn',status:'completed'}}),30);
 if(${JSON.stringify(options.afterRequests)} === 'resolve')
  setTimeout(()=>notify('serverRequest/resolved',{threadId:'parent',requestId:requests[0].id}),30);

});
`, { mode: 0o755 });
  const oldPath = process.env.CASM_CODEX_PATH;
  process.env.CASM_CODEX_PATH = binary;
  const asked: { req: PermissionRequest; signal: AbortSignal }[] = [], events: ProviderEvent[] = [], questions: unknown[] = [];
  const session = codexProvider().open({ cwd: dir, config: { env: { CODEX_HOME: join(dir, "home") } }, resumeId: null,
    emit: e => events.push(e), askQuestion: async req => { questions.push(req); throw new Error("unexpected question"); },
    askPermission: async (req, signal): Promise<PermissionAnswer> => {
      asked.push({ req, signal });
      if (options.afterRequests) return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("approval aborted")), { once: true });
      });
      const answer = options.answerFor?.(req) ?? options.answer ?? "allow";
      if (answer === "cancel") throw new Error("dismissed");
      return { decision: answer };
    },
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  await session.send("run fixture", "user", undefined, "owner");
  const responses = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { asked, questions, events, responses, session };
}

for (const kind of ["command", "writeStdin", "file", "permissions"] as const) {
  for (const answer of ["allow", "allowAlways", "deny", "cancel"] as const) {
    test(`Codex approval RPC ${kind}: ${answer}`, { timeout: 10000 }, async t => {
      const f = await fixture(t, [request(kind)], { answer });
      await until(() => f.responses().length === 1);
      const expected = kind === "permissions"
        ? { permissions: answer === "allow" || answer === "allowAlways" ? permissions : {}, scope: answer === "allowAlways" ? "session" : "turn" }
        : { decision: { allow: "accept", allowAlways: "acceptForSession", deny: "decline", cancel: "cancel" }[answer] };
      assert.deepEqual(f.responses(), [{ id: "approval", result: expected }]);
      assert.equal(f.asked.length, 1);
      const { req } = f.asked[0];
      assert.equal(req.toolName, kind === "file" ? "edit" : kind === "permissions" ? "permissions" : "shell");
      assert.equal(req.id, kind === "file" || kind === "permissions" ? "tool" : "approval");
      assert.equal(req.canAlwaysAllow, true);
      if (kind === "file") assert.deepEqual(req.input, { changes: [{ path: "/sandbox/file.txt", kind: "update" }], reason: "Apply patch" });
      if (kind === "permissions") assert.deepEqual(req.input, { ...permissions, reason: "Need access" });
      // "Always" remains session scoped; never answers with a permanent
      // execpolicy/network amendment merely because one was proposed.
      assert.ok(!JSON.stringify(f.responses()).includes("Amendment"));
      assert.ok(!f.events.some(e => e.type === "turnEnded"));
    });
  }
}

for (const kind of ["command", "writeStdin"] as const) test(`Codex ${kind} approval preserves action kind and managed network context`, async t => {
  const f = await fixture(t, [request(kind)]);
  await until(() => f.responses().length === 1);
  const input = f.asked[0].req.input as Record<string, unknown>;
  assert.equal(input.kind, kind);
  assert.deepEqual(input.networkApprovalContext, networkApprovalContext);
  assert.equal(input.command, kind === "writeStdin" ? "yes\\n" : "curl https://example.test");
});

for (const kind of ["command", "file", "permissions"] as const) test(`Codex turn completion aborts outstanding ${kind} approval safely`, async t => {
  const f = await fixture(t, [request(kind)], { afterRequests: "complete" });
  await until(() => f.responses().length === 1);
  assert.equal(f.asked[0].signal.aborted, true);
  assert.deepEqual(f.responses()[0], { id: "approval", result: kind === "permissions" ? { permissions: {}, scope: "turn" } : { decision: "cancel" } });
  assert.equal(f.events.filter(e => e.type === "turnEnded").length, 1);
});

test("Codex resolved callback aborts only its approval by RPC ID", async t => {
  const f = await fixture(t, [request("command", "rpc-one"), request("writeStdin", "rpc-two")], { afterRequests: "resolve" });
  await until(() => f.responses().length === 1);
  assert.deepEqual(f.responses(), [{ id: "rpc-one", result: { decision: "cancel" } }]);
  assert.equal(f.asked[0].signal.aborted, true);
  assert.equal(f.asked[1].signal.aborted, false);
  await f.session.close();
  assert.equal(f.asked[1].signal.aborted, true);
});

test("Codex distinct command callbacks for the same tool route independent answers", async t => {
  const f = await fixture(t, [request("command", "first"), request("writeStdin", "second")], { answerFor: req => req.id === "first" ? "allowAlways" : "deny" });
  await until(() => f.responses().length === 2);
  assert.deepEqual(f.responses().sort((a,b) => a.id.localeCompare(b.id)), [
    { id: "first", result: { decision: "acceptForSession" } }, { id: "second", result: { decision: "decline" } },
  ]);
});

for (const kind of ["command", "file", "permissions"] as const) test(`Codex child ${kind} approval cannot prompt the parent`, async t => {
  const f = await fixture(t, [request(kind, "child-approval", "child")]);
  await until(() => f.responses().length === 1);
  assert.equal(f.asked.length, 0, "child approvals must not use parent permission callbacks");
  const response = f.responses()[0];
  assert.equal(response.id, "child-approval");
  assert.deepEqual(response.error, { code: -32603, message: "Request belongs to another Codex thread" });
  assert.equal(response.result, undefined);
});


for (const method of ["item/tool/requestUserInput", "mcpServer/elicitation/request"] as const) test(`Codex child ${method} cannot question the parent`, async t => {
  const params = method === "item/tool/requestUserInput"
    ? { threadId: "child", turnId: "turn", itemId: "tool", questions: [{ id: "q", header: "Choice", question: "Continue?", options: null }] }
    : { threadId: "child", serverName: "docs", mode: "url", message: "Login", url: "https://example.test/login", elicitationId: "elicit" };
  const f = await fixture(t, [{ id: "child-question", method, params }]);
  await until(() => f.responses().length === 1);
  assert.equal(f.asked.length, 0);
  assert.equal(f.questions.length, 0);
  assert.deepEqual(f.responses(), [{ id: "child-question", error: { code: -32603, message: "Request belongs to another Codex thread" } }]);
});

for (const thread of [null, undefined]) test(`Codex optional MCP thread identity ${String(thread)} remains compatible`, async t => {
  const f = await fixture(t, [{ id: "optional-thread", method: "mcpServer/elicitation/request", params: {
    ...(thread === undefined ? {} : { threadId: thread }), serverName: "docs", mode: "url", message: "Login", url: "https://example.test/login", elicitationId: "elicit",
  } }]);
  await until(() => f.responses().length === 1);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.responses(), [{ id: "optional-thread", result: { action: "accept", content: null, _meta: null } }]);
});

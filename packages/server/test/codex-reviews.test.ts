import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvalReview } from "../src/providers/codex-reviews.ts";
import { codexProvider } from "../src/providers/codex.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const base = { threadId: "parent", turnId: "turn", reviewId: "review1", targetItemId: "cmd", startedAtMs: 1700000000000,
  review: { status: "inProgress" }, action: { type: "command", command: "npm test", cwd: "/repo", source: "shell" } };

test("review decisions retain exact action, target, rationale and times without completing the tool", () => {
  for (const [status, label, state] of [["inProgress", "Approval review", "running"], ["approved", "Review approved", "done"], ["denied", "Review denied", "error"], ["timedOut", "Review timed out", "error"], ["aborted", "Review cancelled", "error"], ["future", "Review outcome unknown", "error"]]) {
    const item = approvalReview({ ...base, completedAtMs: 1700000002000, review: { status, riskLevel: "low", userAuthorization: "high", rationale: "Requested tests" } })!;
    assert.equal(item.id, "review:review1");
    assert.equal(item.name, label);
    assert.equal(item.status, state);
    assert.deepEqual(item.input, { description: "npm test", action: base.action, targetItemId: "cmd" });
    assert.match(item.output!, /Requested tests\nRisk: low\nUser authorization: high/);
    assert.equal(item.at, "2023-11-14T22:13:20.000Z");
    assert.equal(item.endedAt, "2023-11-14T22:13:22.000Z");
    if (status === "approved") assert.match(item.output!, /does not mean the action ran/);
  }
  assert.equal(approvalReview({ ...base, reviewId: null }), null);
});

test("all seven review actions keep their payload and readable context, including targetless network reviews", () => {
  for (const [action, summary] of [
    [base.action, "npm test"],
    [{ type: "execve", program: "git", argv: ["git", "status"], cwd: "/repo" }, 'git ["git","status"]'],
    [{ type: "writeStdin", processId: "pty1", approvalId: "a", stdin: "yes\n", cwd: "/repo" }, 'Input to pty1: "yes\\n"'],
    [{ type: "applyPatch", files: ["/repo/a", "/repo/b"], cwd: "/repo" }, "Edit files: /repo/a, /repo/b"],
    [{ type: "networkAccess", target: "https://example.com:443", host: "example.com", protocol: "https", port: 443 }, "Network: https://example.com:443"],
    [{ type: "mcpToolCall", server: "docs", toolName: "search", connectorId: null }, "MCP: docs/search"],
    [{ type: "requestPermissions", reason: "Read project", permissions: { fileSystem: { read: ["/repo"] } } }, "Permissions: Read project"],
  ] as const) {
    const item = approvalReview({ ...base, action, targetItemId: null })!;
    assert.deepEqual(item.input, { description: summary, action });
  }
});

test("stdio reviews update independently, ignore child events, retain warnings and close unfinished reviews truthfully", { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "casm-reviews-"));
  const binary = join(dir, "codex.cjs");
  const oldPath = process.env.CASM_CODEX_PATH;
  const events: ProviderEvent[] = [];
  const fence = Promise.withResolvers<void>();
  writeFileSync(binary, `#!${process.execPath}
const { createInterface } = require('node:readline');
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => write({method, params});
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if (m.method === 'thread/start') result = {thread:{id:'parent'}, model:'fake', reasoningEffort:null};
  if (m.method === 'skills/list' || m.method === 'collaborationMode/list') result = {data:[]};
  if (m.method === 'turn/start') result = {turn:{id:'turn',status:'inProgress'}};
  write({id:m.id,result});
  if (m.method !== 'turn/start') return;
  const p = ${JSON.stringify(base)};
  const start = x => notify('item/autoApprovalReview/started', {...p,...x});
  const done = x => notify('item/autoApprovalReview/completed', {...p,completedAtMs:1700000002000,review:{status:'approved',rationale:'Tests requested'},...x});
  notify('turn/started',{threadId:'parent',turn:{id:'turn'}});
  start({}); start({reviewId:'review2',action:{type:'writeStdin',processId:'pty',stdin:'y'}});
  start({threadId:'child',reviewId:'private'});
  start({threadId:null,reviewId:'unscoped'});
  notify('guardianWarning',{threadId:'parent',message:'Reviewer is retrying'});
  done({reviewId:'review2',review:{status:'denied',rationale:'Not authorized'}});
  done({}); start({});
  start({reviewId:'unfinished'});
  notify('autoApprovalReview/strictReviewRequired',{threadId:'parent',turnId:'turn',startedAtMs:1700000000000});
  notify('turn/completed',{threadId:'parent',turn:{id:'turn',status:'interrupted'}});
  start({reviewId:'late'});
  notify('warning',{threadId:'parent',message:'test-fence'});
});
`, { mode: 0o755 });
  process.env.CASM_CODEX_PATH = binary;
  const session = codexProvider().open({ cwd: dir, config: {}, resumeId: null,
    emit: e => {
      events.push(e);
      if (e.type === "item" && e.item.kind === "notice" && e.item.text === "test-fence") fence.resolve();
      if (e.type === "closed") fence.reject(new Error(e.error ?? "closed"));
    }, askPermission: async () => { throw new Error("unexpected human approval"); }, askQuestion: async () => null,
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("test", "user");
  await fence.promise;
  const reviews = events.flatMap(e => e.type === "item" && e.item.kind === "tool" ? [{ item: e.item, history: e.history }] : []);
  assert.deepEqual(reviews.map(e => e.item.id), ["review:review1", "review:review2", "review:review2", "review:review1", "review:unfinished", "review:unfinished"]);
  assert.ok(reviews.every(e => e.history?.beforeItemId === "cmd"));
  assert.equal(reviews.at(-1)!.item.name, "Review outcome unknown");
  assert.match(reviews.at(-1)!.item.output!, /does not indicate approval or denial/);
  assert.ok(events.some(e => e.type === "item" && e.item.kind === "notice" && e.item.text === "Reviewer is retrying"));
  assert.ok(events.some(e => e.type === "item" && e.item.kind === "notice" && e.item.id.startsWith("strict-review:")));
});

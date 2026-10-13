import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, unwrapShell, type CodexItem } from "../src/providers/codex.ts";

// Trimmed from real `thread/items/list` output (codex-cli 0.160.1).
const fx = {
  user: {
    type: "userMessage",
    id: "01a13491-ac28-72b3-9c24-489533e57af7",
    clientId: "casm-item-1",
    content: [{ type: "text", text: "Run `ls`", text_elements: [] }],
  },
  userNoClient: { type: "userMessage", id: "u2", clientId: null, content: [{ type: "text", text: "hi", text_elements: [] }, { type: "localImage", path: "/x.png" }] },
  commentaryEmpty: { type: "agentMessage", id: "msg_1", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  answer: { type: "agentMessage", id: "msg_2", text: "done", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  reasoningEmpty: { type: "reasoning", id: "rs_1", summary: [], content: [] },
  reasoningContent: { type: "reasoning", id: "rs_2", summary: [], content: ['The user said "hi".'] },
  cmdStarted: {
    type: "commandExecution",
    id: "exec-1",
    command: "/bin/bash -lc ls",
    cwd: "/work",
    status: "inProgress",
    commandActions: [{ type: "listFiles", command: "ls", path: null }],
    aggregatedOutput: null,
    exitCode: null,
  },
  cmdFailed: {
    type: "commandExecution",
    id: "exec-2",
    command: "/bin/bash -lc 'xdg-open index.html'",
    cwd: "/work",
    status: "failed",
    aggregatedOutput: "/bin/bash: line 1: xdg-open: command not found\n",
    exitCode: 127,
  },
  cmdDeclined: { type: "commandExecution", id: "exec-3", command: "/bin/bash -lc 'touch denied.txt'", cwd: "/work", status: "declined", aggregatedOutput: null },
  fileChange: {
    type: "fileChange",
    id: "exec-4",
    changes: [{ path: "/work/notes.md", kind: { type: "add" }, diff: "# Notes\n" }],
    status: "completed",
  },
  mcpOk: {
    type: "mcpToolCall",
    id: "call_a",
    server: "paseo",
    tool: "speak",
    status: "completed",
    arguments: { text: "hello" },
    result: { content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true }, _meta: null },
    error: null,
  },
  mcpFailed: { type: "mcpToolCall", id: "call_b", server: "paseo", tool: "speak", status: "failed", arguments: {}, result: null, error: { message: "review failed" } },
  webSearch: { type: "webSearch", id: "ws_1", query: "terra repo", action: { type: "search", query: null, queries: ["terra repo"] } },
  collab: { type: "collabAgentToolCall", id: "call_c", tool: "wait", status: "completed", senderThreadId: "t1", receiverThreadIds: [], prompt: null, model: null, agentsStates: {} },
  subAgent: { type: "subAgentActivity", id: "call_d", kind: "started", agentThreadId: "t2", agentPath: "/root/feasibility" },
  compaction: { type: "contextCompaction", id: "c1" },
} satisfies Record<string, CodexItem>;

test("user messages use the client id casm sent, so history matches live ids", () => {
  assert.deepEqual(normalize(fx.user), { kind: "user", id: "casm-item-1", text: "Run `ls`" });
  assert.deepEqual(normalize(fx.userNoClient), { kind: "user", id: "u2", text: "hi\n[localImage]" });
});

test("empty assistant and reasoning items are skipped; reasoning falls back to raw content", () => {
  assert.equal(normalize(fx.commentaryEmpty), null);
  assert.equal(normalize(fx.reasoningEmpty), null);
  assert.deepEqual(normalize(fx.answer), { kind: "assistant", id: "msg_2", text: "done" });
  assert.deepEqual(normalize(fx.reasoningContent), { kind: "reasoning", id: "rs_2", text: 'The user said "hi".' });
});

test("command executions become shell tools updated in place", () => {
  assert.deepEqual(normalize(fx.cmdStarted, true), { kind: "tool", id: "exec-1", name: "shell", input: { command: "ls", cwd: "/work" }, status: "running" });
  assert.deepEqual(normalize(fx.cmdFailed), {
    kind: "tool",
    id: "exec-2",
    name: "shell",
    input: { command: "xdg-open index.html", cwd: "/work" },
    status: "error",
    output: "/bin/bash: line 1: xdg-open: command not found\n",
  });
  const declined = normalize(fx.cmdDeclined);
  assert.equal(declined?.kind === "tool" && declined.status, "error");
  assert.equal(declined?.kind === "tool" && declined.output, "Declined by the user.");
});

test("file changes, MCP, web search and collab calls map to tools", () => {
  assert.deepEqual(normalize(fx.fileChange), {
    kind: "tool",
    id: "exec-4",
    name: "edit",
    input: { changes: [{ path: "/work/notes.md", kind: "add" }] },
    status: "done",
    output: "/work/notes.md\n# Notes\n",
  });
  assert.deepEqual(normalize(fx.mcpOk), { kind: "tool", id: "call_a", name: "mcp__paseo__speak", input: { text: "hello" }, status: "done", output: '{"ok":true}' });
  assert.deepEqual(normalize(fx.mcpFailed), { kind: "tool", id: "call_b", name: "mcp__paseo__speak", input: {}, status: "error", output: "review failed" });
  const tool = (i: CodexItem, live = false) => normalize(i, live) as { name: string; status: string };
  assert.deepEqual([tool(fx.webSearch).name, tool(fx.webSearch).status, tool(fx.webSearch, true).status], ["web_search", "done", "running"]);
  assert.equal(tool(fx.collab).name, "agent.wait");
});

test("bookkeeping items become notices", () => {
  assert.deepEqual(normalize(fx.subAgent), { kind: "notice", id: "call_d", text: "Subagent /root/feasibility started" });
  assert.deepEqual(normalize(fx.compaction), { kind: "notice", id: "c1", text: "Context compacted" });
});

test("tool output is truncated", () => {
  const big = normalize({ ...fx.cmdFailed, aggregatedOutput: "x".repeat(9000) });
  assert.ok(big?.kind === "tool" && big.output!.length < 8100 && big.output!.endsWith("(truncated)"));
});

test("unwrapShell strips the login-shell wrapper only when it is unambiguous", () => {
  assert.equal(unwrapShell("/bin/bash -lc ls"), "ls");
  assert.equal(unwrapShell("/bin/bash -lc 'sleep 8'"), "sleep 8");
  assert.equal(unwrapShell(`/bin/bash -lc "echo 'a'"`), `/bin/bash -lc "echo 'a'"`);
  assert.equal(unwrapShell("git status"), "git status");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collaborationMode,
  elicitationQuestion,
  MODE_INFO,
  MODES,
  elicitationResponse,
  normalize,
  parseModels,
  unwrapShell,
  userInputQuestion,
  userInputResponse,
  type CodexItem,
} from "../src/providers/codex.ts";

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

// Captured from codex-cli 0.160.1 app-server requests.
const userInput = {
  threadId: "01a134ac-e57c-7c20-886c-558bea30bbcb",
  turnId: "01a134ac-e5cb-77f2-8d9b-fbf2ad3b5cc2",
  itemId: "call_d40a1d6298534c0bbb5177cf57805495",
  questions: [
    {
      id: "color",
      header: "Color",
      question: "Which color do you prefer?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Red", description: "Choose red." },
        { label: "Green", description: "Choose green." },
      ],
    },
    { id: "name", header: "Name", question: "What should I call you?", isOther: false, isSecret: false, options: null },
  ],
  isBlocking: false,
  autoResolutionMs: null,
};

test("requestUserInput questions become select/text prompts", () => {
  assert.deepEqual(userInputQuestion(userInput, "call_1"), {
    id: "call_1",
    prompts: [
      {
        id: "color",
        text: "Which color do you prefer?",
        header: "Color",
        kind: "select",
        options: [
          { label: "Red", description: "Choose red." },
          { label: "Green", description: "Choose green." },
        ],
        allowOther: true,
      },
      { id: "name", text: "What should I call you?", header: "Name", kind: "text" },
    ],
  });
});

test("answers map back to per-question answer lists; dismissal answers nothing", () => {
  assert.deepEqual(userInputResponse(userInput, { color: "Green", name: "Ada" }), {
    answers: { color: { answers: ["Green"] }, name: { answers: ["Ada"] } },
  });
  assert.deepEqual(userInputResponse(userInput, { color: ["Red", "teal"], name: "" }), { answers: { color: { answers: ["Red", "teal"] } } });
  assert.deepEqual(userInputResponse(userInput, null), { answers: {} });
});

const pizza = {
  threadId: "t1",
  turnId: "turn1",
  serverName: "elicit",
  mode: "form",
  _meta: null,
  message: "Pizza order details",
  requestedSchema: {
    type: "object",
    properties: {
      count: { type: "integer", title: "How many", default: 1 },
      extraCheese: { type: "boolean", title: "Extra cheese?" },
      note: { type: "string", title: "Note", description: "Anything for the cook" },
      size: { type: "string", title: "Size", oneOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
      crust: { type: "string", enum: ["thin", "deep"], enumNames: ["Thin", "Deep dish"] },
      toppings: { type: "array", title: "Toppings", items: { anyOf: [{ const: "ham", title: "Ham" }, { const: "olive", title: "Olives" }] } },
    },
    required: ["size"],
  },
};

test("form elicitations become one prompt per field", () => {
  const form = elicitationQuestion(pizza, "e1");
  assert.deepEqual(form?.req, {
    id: "e1",
    title: "Pizza order details",
    prompts: [
      { id: "count", text: "How many", header: undefined, kind: "text", placeholder: "1" },
      { id: "extraCheese", text: "Extra cheese?", header: undefined, kind: "confirm" },
      { id: "note", text: "Anything for the cook", header: "Note", kind: "text", placeholder: undefined },
      { id: "size", text: "Size", header: undefined, kind: "select", options: [{ label: "Small" }, { label: "Large" }], multiple: undefined },
      { id: "crust", text: "crust", header: undefined, kind: "select", options: [{ label: "Thin" }, { label: "Deep dish" }], multiple: undefined },
      { id: "toppings", text: "Toppings", header: undefined, kind: "select", options: [{ label: "Ham" }, { label: "Olives" }], multiple: true },
    ],
  });
  assert.deepEqual(
    elicitationResponse(form!, { count: "2", extraCheese: true, note: "well done", size: "Large", crust: "Deep dish", toppings: ["Ham", "Olives"] }),
    { action: "accept", content: { count: 2, extraCheese: true, note: "well done", size: "l", crust: "deep", toppings: ["ham", "olive"] }, _meta: null },
  );
  assert.deepEqual(elicitationResponse(form!, { size: "Small", count: "lots" }), { action: "accept", content: { size: "s" }, _meta: null });
  assert.deepEqual(elicitationResponse(form!, null), { action: "cancel", content: null, _meta: null });
});

test("empty, url and unsupported elicitations are not questions", () => {
  const approval = { ...pizza, message: "Allow the elicit MCP server to run tool?", requestedSchema: { type: "object", properties: {} } };
  assert.equal(elicitationQuestion(approval, "e"), null);
  assert.equal(elicitationQuestion({ ...pizza, mode: "url", url: "https://x", elicitationId: "u1" }, "e"), null);
  assert.equal(elicitationQuestion({ ...pizza, requestedSchema: { type: "object", properties: { o: { type: "object" } } } }, "e"), null);
});

test("model/list parses into catalog models", () => {
  // Trimmed from real model/list output.
  const data = [
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and everyday work.",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
      ],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
    { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", description: "", hidden: false, supportedReasoningEfforts: [], isDefault: false },
    { id: "old", model: "old", displayName: "Old", hidden: true, supportedReasoningEfforts: [], isDefault: false },
  ];
  assert.deepEqual(parseModels(data), [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work.", isDefault: true, efforts: ["low", "high"] },
    { id: "gpt-6-luna", name: "GPT-6-Luna", description: undefined, isDefault: false },
  ]);
});

test("catalog modes are Paseo's Codex modes plus Plan, in order", () => {
  assert.deepEqual(
    MODE_INFO.map((m) => [m.id, m.name]),
    [
      ["plan", "Plan mode"],
      ["auto", "Default permissions"],
      ["auto-review", "Auto-review"],
      ["full-access", "Full access"],
    ],
  );
  assert.deepEqual(Object.keys(MODES), MODE_INFO.map((m) => m.id));
  assert.equal(MODES["auto-review"].approvalsReviewer, "auto_review");
  assert.equal(MODES.auto.approvalsReviewer, "user");
  assert.deepEqual(
    Object.entries(MODES).filter(([, m]) => m.collaboration === "plan").map(([id]) => id),
    ["plan"],
  );
});

test("collaborationMode carries the agent's model and effort, else the preset's, else the thread's", () => {
  // Real collaborationMode/list output (codex-cli 0.160.1).
  const presets = [
    { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
    { name: "Default", mode: "default", model: null, reasoning_effort: null },
  ];
  const thread = { model: "gpt-6-luna", effort: "high" };
  assert.deepEqual(collaborationMode("plan", presets, { model: "gpt-5.6-luna", effort: "low" }, thread), {
    mode: "plan",
    settings: { model: "gpt-5.6-luna", reasoning_effort: "low", developer_instructions: null },
  });
  assert.deepEqual(collaborationMode("plan", presets, {}, thread).settings, { model: "gpt-6-luna", reasoning_effort: "medium", developer_instructions: null });
  assert.deepEqual(collaborationMode("default", presets, {}, thread), {
    mode: "default",
    settings: { model: "gpt-6-luna", reasoning_effort: "high", developer_instructions: null },
  });
  // No presets (list failed): the bare kind with the thread's settings.
  assert.deepEqual(collaborationMode("plan", [], {}, { model: "m", effort: null }).settings, { model: "m", reasoning_effort: null, developer_instructions: null });
});

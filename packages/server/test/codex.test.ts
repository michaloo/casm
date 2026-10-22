import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_COMMANDS,
  collaborationMode,
  errorNotice,
  parseSkills,
  planEntries,
  planUpdate,
  promptInput,
  rolloutUsage,
  routePrompt,
  skillCommands,
  tokenUsage,
  warningNotice,
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
    server: "voice",
    tool: "speak",
    status: "completed",
    arguments: { text: "hello" },
    result: { content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true }, _meta: null },
    error: null,
  },
  mcpFailed: { type: "mcpToolCall", id: "call_b", server: "voice", tool: "speak", status: "failed", arguments: {}, result: null, error: { message: "review failed" } },
  webSearch: { type: "webSearch", id: "ws_1", query: "terra repo", action: { type: "search", query: null, queries: ["terra repo"] } },
  collab: { type: "collabAgentToolCall", id: "call_c", tool: "wait", status: "completed", senderThreadId: "t1", receiverThreadIds: [], prompt: null, model: null, agentsStates: {} },
  subAgent: { type: "subAgentActivity", id: "call_d", kind: "started", agentThreadId: "t2", agentPath: "/root/feasibility" },
  compaction: { type: "contextCompaction", id: "c1" },
} satisfies Record<string, CodexItem>;

test("user messages use the client id casm sent, so history matches live ids", () => {
  assert.deepEqual(normalize(fx.user), { kind: "user", id: "casm-item-1", text: "Run `ls`" });
  assert.deepEqual(normalize(fx.userNoClient), { kind: "user", id: "u2", text: "hi", images: [{ mediaType: "image/png" }] });
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

test("file changes, MCP and web search map to tools", () => {
  assert.deepEqual(normalize(fx.fileChange), {
    kind: "tool",
    id: "exec-4",
    name: "edit",
    input: { changes: [{ path: "/work/notes.md", kind: "add" }] },
    status: "done",
    output: "/work/notes.md\n# Notes\n",
  });
  assert.deepEqual(normalize(fx.mcpOk), { kind: "tool", id: "call_a", name: "mcp__voice__speak", input: { text: "hello" }, status: "done", output: '{"ok":true}' });
  assert.deepEqual(normalize(fx.mcpFailed), { kind: "tool", id: "call_b", name: "mcp__voice__speak", input: {}, status: "error", output: "review failed" });
  const tool = (i: CodexItem, live = false) => normalize(i, live) as { name: string; status: string };
  assert.deepEqual([tool(fx.webSearch).name, tool(fx.webSearch).status, tool(fx.webSearch, true).status], ["web_search", "done", "running"]);
  assert.equal(normalize(fx.collab), null);
});

test("bookkeeping items become notices", () => {
  assert.deepEqual(normalize(fx.subAgent), { kind: "subagent", id: "t2", title: "/root/feasibility", status: "running" });
  assert.deepEqual(normalize(fx.compaction), { kind: "notice", id: "c1", text: "Context compacted", level: "info" });
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
      ["auto", "Codex defaults"],
      ["auto-review", "Auto-review"],
      ["full-access", "Full access"],
    ],
  );
  // "auto" applies no overrides: Codex's own config.toml decides sandbox and approvals.
  assert.deepEqual(Object.keys(MODES), MODE_INFO.map((m) => m.id).filter((id) => id !== "auto"));
  assert.equal(MODES.auto, undefined);
  assert.equal(MODES["auto-review"].approvalsReviewer, "auto_review");
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

// --- chat features. Fixtures trimmed from live codex-cli 0.160.1 app-server output.

const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNa";

test("images go out as data: URLs and come back on the user item", () => {
  assert.deepEqual(promptInput("What colour?", [{ mediaType: "image/png", data: RED_PNG }]), [
    { type: "text", text: "What colour?", text_elements: [] },
    { type: "image", url: `data:image/png;base64,${RED_PNG}` },
  ]);
  assert.deepEqual(promptInput("", [{ mediaType: "image/png", data: "QQ==" }]), [{ type: "image", url: "data:image/png;base64,QQ==" }]);
  const user = {
    type: "userMessage",
    id: "01a13509-718e-7d63-9d47-9014d6879202",
    clientId: null,
    content: [
      { type: "text", text: "What colour is this image? One word.", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${RED_PNG}` },
    ],
  };
  assert.deepEqual(normalize(user), {
    kind: "user",
    id: "01a13509-718e-7d63-9d47-9014d6879202",
    text: "What colour is this image? One word.",
    images: [{ mediaType: "image/png", data: RED_PNG }],
  });
  // Image only, and too big to inline.
  const big = normalize({ type: "userMessage", id: "u3", content: [{ type: "image", url: `data:image/jpeg;base64,${"A".repeat(1_500_000)}` }] });
  assert.deepEqual(big, { kind: "user", id: "u3", text: "", images: [{ mediaType: "image/jpeg" }] });
});

test("error notifications: retries update one warning per turn, final errors are error notices", () => {
  const failed = {
    error: {
      message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account."}}',
      codexErrorInfo: "other",
      additionalDetails: null,
    },
    willRetry: false,
    threadId: "t",
    turnId: "turn-1",
  };
  assert.deepEqual(errorNotice(failed), {
    kind: "notice",
    id: "error-turn-1",
    text: "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    level: "error",
  });
  const retry = (n: number) => errorNotice({ error: { message: `Reconnecting... ${n}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, willRetry: true, threadId: "t", turnId: "turn-1" });
  assert.equal(retry(1).id, retry(2).id);
  assert.deepEqual(retry(2), { kind: "notice", id: "retry-turn-1", text: "Retrying: Reconnecting... 2/5", level: "warning" });
});

test("warnings become notices with a stable id per text", () => {
  const w = { threadId: "t", message: "Model metadata for `no-such-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." };
  const n = warningNotice("warning", w);
  assert.equal(n.kind === "notice" && n.level, "warning");
  assert.equal(n.kind === "notice" && n.text, w.message);
  assert.equal(n.id, warningNotice("warning", { ...w }).id);
  const cfg = warningNotice("configWarning", { summary: "Codex could not find bubblewrap on PATH.", details: null });
  assert.equal(cfg.kind === "notice" && cfg.text, "Codex could not find bubblewrap on PATH.");
  const dep = warningNotice("deprecationNotice", { summary: "old", details: "use new" });
  assert.deepEqual(dep.kind === "notice" && [dep.text, dep.level], ["old\nuse new", "info"]);
});

test("turn/plan/updated becomes one plan item per turn", () => {
  const p = {
    threadId: "t",
    turnId: "turn-2",
    explanation: null,
    plan: [
      { step: "alpha", status: "inProgress" },
      { step: "beta", status: "pending" },
      { step: "gamma", status: "completed" },
    ],
  };
  assert.deepEqual(planUpdate(p), {
    kind: "plan",
    id: "plan-turn-2",
    entries: [
      { text: "alpha", status: "in_progress" },
      { text: "beta", status: "pending" },
      { text: "gamma", status: "completed" },
    ],
  });
});

test("Plan mode plan items become plans when they are lists, else assistant text", () => {
  const item = {
    type: "plan",
    id: "01a13511-0023-7d00-b6c6-aedacb452fb8-plan",
    text: "1. Create `/tmp/casm-codex-chat/work/hello.txt`.\n2. Write exactly `hi` into the file.\n3. Verify the file contains the expected text.\n",
  };
  assert.deepEqual(normalize(item), {
    kind: "plan",
    id: item.id,
    entries: [
      { text: "Create `/tmp/casm-codex-chat/work/hello.txt`.", status: "pending" },
      { text: "Write exactly `hi` into the file.", status: "pending" },
      { text: "Verify the file contains the expected text.", status: "pending" },
    ],
  });
  assert.deepEqual(planEntries("- [x] done\n- [ ] todo"), [
    { text: "done", status: "completed" },
    { text: "todo", status: "pending" },
  ]);
  assert.deepEqual(normalize({ type: "plan", id: "p2", text: "## Summary\nAdd a file.\n\n- step" }), { kind: "assistant", id: "p2", text: "## Summary\nAdd a file.\n\n- step" });
});

test("token usage maps to context (last request) and thread totals", () => {
  const live = {
    total: { totalTokens: 27723, inputTokens: 27543, cachedInputTokens: 19968, cacheWriteInputTokens: 0, outputTokens: 180, reasoningOutputTokens: 51 },
    last: { totalTokens: 13984, inputTokens: 13809, cachedInputTokens: 9984, cacheWriteInputTokens: 0, outputTokens: 175, reasoningOutputTokens: 51 },
    modelContextWindow: 258400,
  };
  assert.deepEqual(tokenUsage(live, "gpt-5.6-luna"), { model: "gpt-5.6-luna", contextTokens: 13984, contextWindow: 258400, inputTokens: 27543, outputTokens: 180 });
  assert.deepEqual(tokenUsage({ ...live, modelContextWindow: null }), { contextTokens: 13984, inputTokens: 27543, outputTokens: 180 });
});

test("stored usage is read from the rollout's last token_count and turn_context", () => {
  const usage = (o: object) => JSON.stringify(o);
  const jsonl = [
    usage({ type: "turn_context", payload: { turn_id: "a", model: "gpt-5.6-luna", cwd: "/w" } }),
    usage({ type: "event_msg", payload: { type: "token_count", info: null } }),
    usage({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 13301, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 13306 },
          last_token_usage: { input_tokens: 13301, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 13306 },
          model_context_window: 258400,
        },
      },
    }),
    "",
  ].join("\n");
  assert.deepEqual(rolloutUsage(jsonl), { model: "gpt-5.6-luna", contextTokens: 13306, contextWindow: 258400, inputTokens: 13301, outputTokens: 5 });
  assert.equal(rolloutUsage(usage({ type: "session_meta", payload: {} })), null);
});

const skillsList = {
  data: [
    {
      cwd: "/w",
      errors: [],
      skills: [
        { name: "gpu-compute", description: "Use the `gpu` box for heavy jobs.", enabled: true, interface: null, path: "/h/.agents/skills/gpu-compute/SKILL.md", scope: "user", shortDescription: null },
        {
          name: "openai-docs",
          description: "Use when the user asks how to build with OpenAI products or APIs.",
          enabled: true,
          interface: { displayName: "OpenAI Docs", shortDescription: "OpenAI and Codex docs for models, skills, tasks, and setup" },
          path: "/h/.codex/skills/.system/openai-docs/SKILL.md",
          scope: "system",
          shortDescription: "Codex models/pricing",
        },
        { name: "off", description: "disabled", enabled: false, interface: null, path: "/x", scope: "user" },
      ],
    },
  ],
};

test("skills/list becomes skill commands after the routed builtins", () => {
  const skills = parseSkills(skillsList);
  assert.deepEqual(skillCommands(skills), [
    { name: "gpu-compute", description: "Use the `gpu` box for heavy jobs.", kind: "skill" },
    { name: "openai-docs", description: "OpenAI and Codex docs for models, skills, tasks, and setup", kind: "skill" },
  ]);
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name), ["compact", "review"]);
});

test("slash prompts route to compact, review, skill inputs or plain text", () => {
  const skills = parseSkills(skillsList);
  assert.deepEqual(routePrompt("/compact", skills), { kind: "compact" });
  assert.deepEqual(routePrompt("/review", skills), { kind: "review", instructions: "" });
  assert.deepEqual(routePrompt("/review focus on auth", skills), { kind: "review", instructions: "focus on auth" });
  assert.deepEqual(routePrompt("/openai-docs what is this skill?", skills), {
    kind: "input",
    input: [
      { type: "text", text: "$openai-docs what is this skill?", text_elements: [] },
      { type: "skill", name: "openai-docs", path: "/h/.codex/skills/.system/openai-docs/SKILL.md" },
    ],
  });
  assert.deepEqual(routePrompt("/nope x", skills), { kind: "input", input: [{ type: "text", text: "/nope x", text_elements: [] }] });
  assert.deepEqual(routePrompt("/compact now", skills), { kind: "input", input: [{ type: "text", text: "/compact now", text_elements: [] }] });
});

test("skill invocations read back as the slash command that was typed", () => {
  const item = {
    type: "userMessage",
    id: "01a13512-886a-7911-b760-9dbd218dbf26",
    clientId: "casm-1",
    content: [
      { type: "text", text: "$openai-docs what is the name of this skill? one line", text_elements: [] },
      { type: "skill", name: "openai-docs", path: "/home/user/.codex/skills/.system/openai-docs/SKILL.md" },
    ],
  };
  assert.deepEqual(normalize(item), { kind: "user", id: "casm-1", text: "/openai-docs what is the name of this skill? one line" });
});

test("only userShell command executions carry user origin, live and completed", () => {
  for (const running of [true, false]) {
    const raw = { ...fx.cmdStarted, source: "userShell" };
    const item = normalize(raw, running);
    assert.ok(item?.kind === "tool");
    assert.equal(item.origin, "user");
    const agent = normalize({ ...raw, source: "agent" }, running);
    assert.ok(agent?.kind === "tool");
    assert.equal(agent.origin, undefined);
  }
});

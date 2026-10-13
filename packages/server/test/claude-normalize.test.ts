import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKTaskStartedMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Normalizer, bashRecord, bashResult, chain, historyItems, parseCommands, parseLines, promptContent, usageFromLines, type Entry } from "../src/providers/claude.ts";

// Task_* frames from SDK 0.3.296. A background task can outlive the
// foreground result and a resumed task reuses task_id with a newer run_id.
const taskStart = {
  type: "system", subtype: "task_started", task_id: "child-1", run_id: "run-001",
  description: "Review authentication", subagent_type: "Explore", task_type: "local_agent",
  is_backgrounded: false,
  uuid: "00000000-0000-0000-0000-000000000001", session_id: "session-1",
} satisfies SDKTaskStartedMessage;

test("Claude task lifecycle upserts one notice and survives foreground turn completion", () => {
  const n = new Normalizer();
  const start = n.entry(taskStart);
  assert.deepEqual(start, [{ kind: "notice", id: "claude-task:child-1", level: "info", text: "Subagent (Explore) running: Review authentication" }]);
  const update = n.entry({ ...taskStart, subtype: "task_updated", patch: { is_backgrounded: true } });
  assert.match((update[0] as { text: string }).text, /running \(background\)/);
  n.endTurn();
  const progress = n.entry({
    ...taskStart, subtype: "task_progress", is_backgrounded: true, last_tool_name: "Grep",
    summary: "Checking token validation", usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 2500 },
  });
  assert.equal(progress[0]?.id, start[0]?.id);
  assert.match((progress[0] as { text: string }).text, /Checking token validation\n3 tool uses · 1234 tokens · 3s · last tool: Grep/);
  const done = n.entry({
    type: "system", subtype: "task_notification", task_id: "child-1", run_id: "run-001",
    status: "completed", summary: "No authentication issues found", output_file: "/unused/result",
  });
  assert.deepEqual(done, [{
    kind: "notice", id: "claude-task:child-1", level: "info",
    text: "Subagent (Explore) completed: Review authentication\nNo authentication issues found\n3 tool uses · 1234 tokens · 3s",
  }]);
});

test("Claude tasks reject stale frames and permit a new run of the same task", () => {
  const n = new Normalizer();
  n.entry(taskStart);
  const done = { ...taskStart, subtype: "task_notification", status: "completed", summary: "First run done" };
  n.entry(done);
  assert.deepEqual(n.entry(done), []); // Duplicate notification.
  assert.deepEqual(n.entry(taskStart), []); // Late start cannot revive a finished run.
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_updated", patch: { status: "running" } }), []);
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_progress", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }), []);
  const resumed = n.entry({ ...taskStart, run_id: "run-002", is_backgrounded: true });
  assert.equal(resumed[0]?.id, "claude-task:child-1");
  assert.match((resumed[0] as { text: string }).text, /running \(background\)/);
  assert.deepEqual(n.entry(done), []); // Late completion of the older run.
  assert.deepEqual(n.entry({ ...done, run_id: undefined }), []); // Unversioned frame cannot override a versioned run.
});

test("Claude hides ambient tasks and does not materialize unknown progress or patches", () => {
  const n = new Normalizer();
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_progress", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 } }), []);
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_updated", patch: { status: "running" } }), []);
  assert.deepEqual(n.entry({ ...taskStart, ambient: true }), []);
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_progress", usage: { total_tokens: 8, tool_uses: 1, duration_ms: 20 } }), []);
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_notification", status: "completed", summary: "Housekeeping done" }), []);
  assert.deepEqual(n.entry({ ...taskStart, task_id: "hidden", skip_transcript: true }), []);
  assert.deepEqual(n.entry({ ...taskStart, task_id: "hidden", subtype: "task_notification", status: "failed" }), []);
});

test("Claude task pauses, failures and standalone completion remain visible with useful severity", () => {
  const n = new Normalizer();
  n.entry(taskStart);
  const paused = n.entry({ ...taskStart, subtype: "task_updated", patch: { status: "paused" } });
  assert.match((paused[0] as { text: string }).text, /paused/);
  const failed = n.entry({ ...taskStart, subtype: "task_updated", patch: { status: "failed", error: "Model unavailable" } });
  assert.deepEqual(failed, [{ kind: "notice", id: "claude-task:child-1", level: "error", text: "Subagent (Explore) failed: Review authentication\nModel unavailable" }]);
  const stopped = n.entry({ type: "system", subtype: "task_notification", task_id: "older-task", status: "stopped", summary: "Worker restarted" });
  assert.deepEqual(stopped, [{ kind: "notice", id: "claude-task:older-task", level: "warning", text: "Task stopped: older-task\nWorker restarted" }]);
  const enriched = n.entry({ ...taskStart, subtype: "task_notification", status: "failed", summary: "Final failure details" });
  assert.match((enriched[0] as { text: string }).text, /Final failure details/);
});

test("Claude task notices are bounded and malformed records are ignored", () => {
  const n = new Normalizer();
  const item = n.entry({ ...taskStart, description: "x".repeat(9000) })[0];
  assert.equal((item as { text: string }).text.length, 8000);
  assert.deepEqual(n.entry({ ...taskStart, task_id: "" }), []);
  assert.deepEqual(n.entry({ ...taskStart, task_id: 42 }), []);
  assert.deepEqual(n.entry({ ...taskStart, subtype: "task_updated", patch: { status: "made-up" } }), []);
});

test("normalizes a tool call and completes it from the tool result", () => {
  const n = new Normalizer();
  const call = n.entry({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
      ],
    },
  });
  assert.deepEqual(
    call.map((i) => i.kind),
    ["reasoning", "assistant", "tool"],
  );
  const result = n.entry({
    type: "user",
    uuid: "u2",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "contents" }] }] },
  });
  assert.deepEqual(result, [{ kind: "tool", id: "t1", name: "Read", input: { file_path: "/x" }, status: "done", output: "contents" }]);
});

test("user prompts become user items; empty text and meta lines are skipped", () => {
  const n = new Normalizer();
  assert.deepEqual(n.entry({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }), [
    { kind: "user", id: "u1", text: "hi", images: undefined },
  ]);
  assert.deepEqual(n.entry({ type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "  " }] } }), []);
  // Claude adds an isMeta line pointing at its copy of a pasted image.
  assert.deepEqual(n.entry({ type: "user", uuid: "m", isMeta: true, message: { role: "user", content: [{ type: "text", text: "[Image: source: /tmp/x/1.png]" }] } }), []);
});

test("Claude's interrupt marker becomes a notice", () => {
  assert.deepEqual(
    new Normalizer().entry({ type: "user", uuid: "u9", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
    [{ kind: "notice", id: "u9", text: "Interrupted" }],
  );
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXElEQVR4nO3PwQ3AMAwDMe+/dDNEHxcjPG";

test("images: prompt content and history", () => {
  assert.equal(promptContent("hi"), "hi");
  assert.deepEqual(promptContent("What colour?", [{ mediaType: "image/png", data: png }]), [
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    { type: "text", text: "What colour?" },
  ]);
  const big = "A".repeat(1_500_000);
  const items = new Normalizer().entry({
    type: "user",
    uuid: "u1",
    message: {
      role: "user",
      content: [
        { type: "text", text: "What colour is the big square in this image? One word." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: big } },
      ],
    },
  });
  assert.deepEqual(items, [
    {
      kind: "user",
      id: "u1",
      text: "What colour is the big square in this image? One word.",
      images: [{ mediaType: "image/png", data: png }, { mediaType: "image/jpeg", data: undefined }],
    },
  ]);
});

// Tool calls from a real claude 2.1.292 session (TaskCreate / TaskUpdate).
const taskCreate = (uuid: string, id: string, subject: string): Entry[] => [
  { type: "assistant", uuid: `a-${uuid}`, message: { role: "assistant", content: [{ type: "tool_use", id, name: "TaskCreate", input: { subject, description: "…" } }] } },
  {
    type: "user",
    uuid: `u-${uuid}`,
    toolUseResult: { task: { id: uuid, subject } },
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: `Task #${uuid} created successfully: ${subject}` }] },
  },
];
const taskUpdate = (taskId: string, id: string, status: string): Entry[] => [
  { type: "assistant", uuid: `a-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name: "TaskUpdate", input: { taskId, status } }] } },
  { type: "user", uuid: `u-${id}`, message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: `Updated task #${taskId} status` }] } },
];

test("TaskCreate/TaskUpdate become one plan item; the raw tool items are hidden", () => {
  const n = new Normalizer();
  const out = [
    ...taskCreate("1", "toolu_A", "Plan hello.txt"),
    ...taskCreate("2", "toolu_B", "Write hello.txt"),
    ...taskUpdate("1", "toolu_C", "in_progress"),
    ...taskUpdate("1", "toolu_D", "completed"),
  ].flatMap((e) => n.entry(e));
  assert.ok(out.every((i) => i.kind === "plan" && i.id === "tasks:toolu_A"));
  assert.deepEqual(out.at(-1), {
    kind: "plan",
    id: "tasks:toolu_A",
    entries: [
      { text: "Plan hello.txt", status: "completed" },
      { text: "Write hello.txt", status: "pending" },
    ],
  });
  // Without the structured result (older transcripts) the id comes from the text.
  const m = new Normalizer();
  const e = taskCreate("7", "toolu_E", "X");
  delete e[1]!.toolUseResult;
  [...e, ...taskUpdate("7", "toolu_F", "deleted")].forEach((x) => m.entry(x));
  assert.deepEqual(m.entry(taskCreate("8", "toolu_G", "Y")[0]!), []);
});

test("a new task list after a finished one is a new plan", () => {
  const n = new Normalizer();
  [...taskCreate("1", "t1", "A"), ...taskUpdate("1", "t2", "completed")].forEach((e) => n.entry(e));
  const out = taskCreate("2", "t3", "B").flatMap((e) => n.entry(e));
  assert.deepEqual(out, [{ kind: "plan", id: "tasks:t3", entries: [{ text: "B", status: "pending" }] }]);
});

test("TodoWrite becomes a plan item", () => {
  const n = new Normalizer();
  const todos = [
    { content: "Write tests", status: "completed", activeForm: "Writing tests" },
    { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
  ];
  assert.deepEqual(n.entry({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "tw1", name: "TodoWrite", input: { todos } }] } }), [
    {
      kind: "plan",
      id: "todos:tw1",
      entries: [
        { text: "Write tests", status: "completed" },
        { text: "Fix bug", status: "in_progress" },
      ],
    },
  ]);
  assert.deepEqual(n.entry({ type: "user", uuid: "u", message: { content: [{ type: "tool_result", tool_use_id: "tw1", content: "ok" }] } }), []);
});

test("notices: API errors, informational lines, refusals, slash commands", () => {
  const n = new Normalizer();
  // Real synthetic API error message.
  assert.deepEqual(
    n.entry({
      type: "assistant",
      uuid: "e1",
      isApiErrorMessage: true,
      error: "authentication_failed",
      message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
    }),
    [{ kind: "notice", id: "e1:0", level: "error", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }],
  );
  assert.deepEqual(
    n.entry({ type: "system", subtype: "informational", uuid: "i1", level: "notice", content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" }),
    [{ kind: "notice", id: "i1", level: "info", text: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" }],
  );
  assert.equal(n.entry({ type: "system", subtype: "model_refusal_fallback", uuid: "r1", level: "warning", content: "Opus 4.8 is answering instead" })[0]!.kind, "notice");
  // Stored api_error lines in one turn share one notice.
  const r1 = n.entry({ type: "system", subtype: "api_error", uuid: "x1", retryAttempt: 1, maxRetries: 10 });
  const r2 = n.entry({ type: "system", subtype: "api_error", uuid: "x2", retryAttempt: 2, maxRetries: 10 });
  assert.equal(r1[0]!.id, "x1");
  assert.deepEqual(r2, [{ kind: "notice", id: "x1", level: "warning", text: "API error, retrying (attempt 2/10)" }]);
  // /compact as stored.
  assert.deepEqual(
    n.entry({ type: "user", uuid: "c1", message: { role: "user", content: "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep tests</command-args>" } }),
    [{ kind: "user", id: "c1", text: "/compact keep tests", images: undefined }],
  );
  assert.deepEqual(n.entry({ type: "user", uuid: "c2", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } }), [
    { kind: "notice", id: "c2", level: "info", text: "Compacted" },
  ]);
  assert.deepEqual(n.entry({ type: "user", uuid: "c3", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } }), []);
});

// A trimmed real transcript: a turn, /compact, and an abandoned branch.
const jsonl = [
  { type: "queue-operation", operation: "enqueue" },
  { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Run the loop" } },
  { type: "attachment", uuid: "at1", parentUuid: "u1" },
  { type: "assistant", uuid: "a1", parentUuid: "at1", message: { model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: "old branch" }], usage: { input_tokens: 1 } } },
  { type: "assistant", uuid: "a2", parentUuid: "at1", message: { model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 8, cache_creation_input_tokens: 221, cache_read_input_tokens: 25948, output_tokens: 51 } } },
  { type: "cost-state", totalCostUSD: 0.0619, modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 999, outputTokens: 1105, cacheReadInputTokens: 85101, cacheCreationInputTokens: 23445, costUSD: 0.0619 } } },
  { type: "user", uuid: "lc0", parentUuid: "a2", message: { role: "user", content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" } },
  { type: "system", subtype: "local_command", uuid: "lc1", parentUuid: "lc0", content: "<local-command-stdout>## Context Usage\n\n**Tokens:** 30.9k / 200k (15%)</local-command-stdout>", level: "info" },
  { type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: "lc1", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 26234, postTokens: 4274 } },
  { type: "user", uuid: "cs", parentUuid: "cb", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued…" } },
  { type: "user", uuid: "cv", parentUuid: "cs", isMeta: true, message: { role: "user", content: "<local-command-caveat>…</local-command-caveat>" } },
  { type: "user", uuid: "cmd", parentUuid: "cv", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } },
  { type: "user", uuid: "out", parentUuid: "cmd", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } },
  { type: "last-prompt", lastPrompt: "x" },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

test("history follows the current branch across compaction", () => {
  const lines = parseLines(jsonl + "\n{broken");
  assert.deepEqual(
    chain(lines).map((l) => l.uuid),
    ["u1", "a2", "lc0", "lc1", "cb", "cs", "cv", "cmd", "out"],
  );
  assert.deepEqual(historyItems(lines), [
    { kind: "user", id: "u1", text: "Run the loop", images: undefined },
    { kind: "assistant", id: "a2:0", text: "Done." },
    { kind: "user", id: "lc0", text: "/context", images: undefined },
    { kind: "assistant", id: "lc1:0", text: "## Context Usage\n\n**Tokens:** 30.9k / 200k (15%)" },
    { kind: "notice", id: "cb", level: "info", text: "Conversation compacted (26.2k → 4.3k tokens)" },
    { kind: "user", id: "cmd", text: "/compact", images: undefined },
    { kind: "notice", id: "out", level: "info", text: "Compacted" },
  ]);
});

test("usage from the store", () => {
  const lines = parseLines(jsonl);
  assert.deepEqual(usageFromLines(lines, new Map([["claude-haiku-4-5-20251001", 200000]])), {
    model: "claude-haiku-4-5-20251001",
    // The compaction after the last model call.
    contextTokens: 4274,
    contextWindow: 200000,
    inputTokens: 999 + 85101 + 23445,
    outputTokens: 1105,
    costUsd: 0.0619,
  });
  assert.equal(usageFromLines([]), null);
});

test("commands: skills are told apart by reloadSkills()", () => {
  const cmds: SlashCommand[] = [
    { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>", builtin: true },
    { name: "simplify", description: "Review changed code", argumentHint: "", builtin: true },
    { name: "__remote-workflow", description: "", argumentHint: "", builtin: true },
  ];
  assert.deepEqual(parseCommands(cmds, [{ name: "simplify", description: "", argumentHint: "" }]), [
    { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>", kind: "command" },
    { name: "simplify", description: "Review changed code", argumentHint: undefined, kind: "skill" },
  ]);
});

test("bash mode: casm's one-message record and Claude's two-message form become one shell item", () => {
  const user = (uuid: string, content: unknown): Entry => ({ type: "user", uuid, message: { role: "user", content } });
  const n = new Normalizer();
  const record = bashRecord("for i in 1 2; do echo $i; done; exit 3", "1\n2\n", "oops\n", 3);
  assert.deepEqual(n.entry(user("s1", record)), [
    { kind: "tool", id: "s1", name: "shell", origin: "user", input: { command: "for i in 1 2; do echo $i; done; exit 3" }, status: "error", output: "1\n2\noops" },
  ]);
  assert.equal(record[2]!.text, "<bash-stdout>1\n2</bash-stdout><bash-stderr>oops</bash-stderr><bash-exit-code>3</bash-exit-code>");
  // Claude's TUI: a meta caveat, the input, then the output in its own message.
  assert.deepEqual(n.entry({ ...user("c0", record[0]!.text), isMeta: true }), []);
  assert.deepEqual(n.entry(user("c1", "<bash-input>ls</bash-input>")), [{ kind: "tool", id: "c1", name: "shell", origin: "user", input: { command: "ls" }, status: "running" }]);
  assert.deepEqual(n.entry(user("c2", "<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>")), [
    { kind: "tool", id: "c1", name: "shell", origin: "user", input: { command: "ls" }, status: "done", output: "a.txt" },
  ]);
  // Batched appends are stored joined in one message.
  assert.deepEqual(n.entry(user("j1", `${record[0]!.text}\n<bash-input>pwd</bash-input>\n<bash-stdout>/w</bash-stdout><bash-stderr></bash-stderr>`)), [
    { kind: "tool", id: "j1", name: "shell", origin: "user", input: { command: "pwd" }, status: "done", output: "/w" },
  ]);
  // An interrupted TUI command never gets its output.
  n.entry(user("i1", "<bash-input>sleep 9</bash-input>"));
  assert.deepEqual(n.entry(user("i2", "[Request interrupted by user]")), [
    { kind: "tool", id: "i1", name: "shell", origin: "user", input: { command: "sleep 9" }, status: "error" },
    { kind: "notice", id: "i2", text: "Interrupted" },
  ]);
  assert.deepEqual(bashResult("<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr><bash-exit-code>0</bash-exit-code>"), { output: "x", status: "done" });
});

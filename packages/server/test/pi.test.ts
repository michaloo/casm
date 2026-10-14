import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import {
  argumentHint,
  customPlan,
  dialogQuestion,
  dialogResponse,
  normalize,
  outputDelta,
  parseCatalog,
  parseCommands,
  parseSession,
  planEntries,
  sessionUsage,
  shellItem,
  type PiMessage,
} from "../src/providers/pi.ts";

type Tool = Extract<Item, { kind: "tool" }>;

// Shapes taken from real ~/.pi/agent/sessions files, trimmed and anonymized.
const assistant = (timestamp: number, content: unknown[], extra: Partial<PiMessage> = {}): PiMessage => ({
  role: "assistant",
  content,
  timestamp,
  stopReason: "stop",
  ...extra,
});

test("assistant blocks are keyed by message timestamp; tool calls complete from tool results", () => {
  const tools = new Map<string, Tool>();
  const call = normalize(
    assistant(
      1791747563172,
      [
        { type: "thinking", thinking: "Need to list files.", thinkingSignature: "reasoning_content" },
        { type: "text", text: "Listing." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      { stopReason: "toolUse" },
    ),
    tools,
  );
  assert.deepEqual(call, [
    { kind: "reasoning", id: "1791747563172:0", text: "Need to list files." },
    { kind: "assistant", id: "1791747563172:1", text: "Listing." },
    { kind: "tool", id: "call_1", name: "bash", input: { command: "ls" }, status: "running" },
  ]);
  const result = normalize(
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt\n" }],
      isError: false,
      timestamp: 1791747579346,
    },
    tools,
  );
  assert.deepEqual(result, [{ kind: "tool", id: "call_1", name: "bash", input: { command: "ls" }, status: "done", output: "a.txt\n" }]);
});

test("errors, aborts, empty blocks and long tool output", () => {
  const tools = new Map<string, Tool>();
  assert.deepEqual(normalize(assistant(5, [], { stopReason: "aborted" }), tools), []);
  assert.deepEqual(
    normalize(assistant(6, [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], { stopReason: "aborted" }), tools),
    [{ kind: "tool", id: "c", name: "bash", input: {}, status: "error" }],
  );
  assert.deepEqual(normalize(assistant(7, [{ type: "text", text: "  " }], { stopReason: "error", errorMessage: "503 overloaded" }), tools), [
    { kind: "notice", id: "7:error", text: "503 overloaded", level: "error" },
  ]);
  const [big] = normalize(
    { role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "y".repeat(9000) }], isError: true },
    tools,
  );
  assert.equal(big.kind === "tool" && big.status, "error");
  assert.equal(big.kind === "tool" && big.name, "read");
  assert.ok(big.kind === "tool" && big.output!.endsWith("…(truncated)") && big.output!.length < 8100);
});

test("system messages are skipped; user text uses the entry id", () => {
  const tools = new Map<string, Tool>();
  assert.deepEqual(normalize({ role: "system", content: "", timestamp: 1 }, tools, "e0"), []);
  assert.deepEqual(normalize({ role: "user", content: [{ type: "text", text: "hu" }], timestamp: 2 }, tools, "e1"), [
    { kind: "user", id: "e1", text: "hu" },
  ]);
});

const line = (o: object) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, message: PiMessage) => line({ type: "message", id, parentId, timestamp: "2026-10-11T19:39:09.766Z", message });

const session = [
  line({ type: "session", version: 3, id: "01a1-uuid", timestamp: "2026-10-11T19:39:09.442Z", cwd: "/work" }),
  line({ type: "model_change", id: "m0", parentId: null, timestamp: "t", provider: "llama-server", modelId: "small" }),
  msg("s0", "m0", { role: "system", content: "", timestamp: 100 }),
  msg("u1", "s0", { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 101 }),
  msg("a1", "u1", assistant(102, [{ type: "thinking", thinking: "greet" }, { type: "text", text: "Hi!" }])),
  // Abandoned branch: not on the active path.
  msg("u2x", "a1", { role: "user", content: [{ type: "text", text: "old question" }], timestamp: 103 }),
  msg("a2x", "u2x", assistant(104, [{ type: "text", text: "old answer" }])),
  line({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t", summary: "Greeted the user.", firstKeptEntryId: "u1", tokensBefore: 10 }),
  msg("u2", "c1", { role: "user", content: [{ type: "text", text: "list files" }], timestamp: 105 }),
  msg("a2", "u2", assistant(106, [{ type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" })),
  msg("r2", "a2", { role: "toolResult", toolCallId: "call_9", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 107 }),
  msg("a3", "r2", assistant(108, [{ type: "text", text: "One file." }])),
  "{not json",
  "",
].join("\n");

test("parseSession follows the active branch and upserts tool results", () => {
  assert.deepEqual(parseSession(session), [
    { kind: "user", id: "u1", text: "hello" },
    { kind: "reasoning", id: "102:0", text: "greet" },
    { kind: "assistant", id: "102:1", text: "Hi!" },
    { kind: "notice", id: "c1", text: "Context compacted: Greeted the user.", level: "info" },
    { kind: "user", id: "u2", text: "list files" },
    { kind: "tool", id: "call_9", name: "bash", input: { command: "ls" }, status: "done", output: "a.txt" },
    { kind: "assistant", id: "108:0", text: "One file." },
  ]);
});

test("an empty or header-only session has no items", () => {
  assert.deepEqual(parseSession(""), []);
  assert.deepEqual(parseSession(line({ type: "session", version: 3, id: "x", cwd: "/" })), []);
});

// extension_ui_request shapes from docs/rpc-extension-ui.md and a live rpc run.
test("select, input and editor dialogs become questions; answers map to extension_ui_response", () => {
  const select = dialogQuestion({ type: "extension_ui_request", id: "u1", method: "select", title: "Pick a color", options: ["red", "green", "blue"], timeout: 60000 });
  assert.deepEqual(select, {
    id: "u1",
    prompts: [{ id: "select", text: "Pick a color", kind: "select", options: [{ label: "red" }, { label: "green" }, { label: "blue" }] }],
  });
  assert.deepEqual(dialogResponse(select!, { select: "green" }), { type: "extension_ui_response", id: "u1", value: "green" });
  assert.deepEqual(dialogResponse(select!, { select: ["blue"] }), { type: "extension_ui_response", id: "u1", value: "blue" });
  assert.deepEqual(dialogResponse(select!, null), { type: "extension_ui_response", id: "u1", cancelled: true });
  assert.deepEqual(dialogResponse(select!, {}), { type: "extension_ui_response", id: "u1", cancelled: true });

  const input = dialogQuestion({ type: "extension_ui_request", id: "u2", method: "input", title: "Your name", placeholder: "type something..." });
  assert.deepEqual(input!.prompts, [{ id: "input", text: "Your name", kind: "text", placeholder: "type something..." }]);
  assert.deepEqual(dialogResponse(input!, { input: "" }), { type: "extension_ui_response", id: "u2", value: "" });

  const editor = dialogQuestion({ type: "extension_ui_request", id: "u3", method: "editor", title: "Edit", prefill: "Line 1\nLine 2" });
  assert.deepEqual(editor!.prompts, [{ id: "editor", text: "Edit", kind: "text", multiline: true, placeholder: "Line 1\nLine 2" }]);
  assert.deepEqual(dialogResponse(editor!, { editor: "Line 1" }), { type: "extension_ui_response", id: "u3", value: "Line 1" });

  assert.equal(dialogQuestion({ type: "extension_ui_request", id: "u4", method: "notify", message: "hi" }), null);
  assert.equal(dialogQuestion({ type: "extension_ui_request", id: "u5", method: "confirm", title: "Sure?" }), null);
});

const llama = "llama-server=http://127.0.0.1:8080";
const fullMap = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

test("catalog: thinking levels per model, default from get_state, provider-qualified duplicates", () => {
  const catalog = parseCatalog(
    [
      { id: "laguna-xs-2.1", name: "laguna-xs-2.1", provider: llama, reasoning: true, thinkingLevelMap: fullMap },
      { id: "plain", name: "Plain", provider: llama, reasoning: false },
      { id: "capped", provider: llama, reasoning: true, thinkingLevelMap: { minimal: null } },
      { id: "dup", name: "Dup", provider: "a", reasoning: false },
      { id: "dup", name: "Dup", provider: "b", reasoning: false },
    ],
    { id: "laguna-xs-2.1", provider: llama },
  );
  assert.deepEqual(catalog, {
    models: [
      { id: "laguna-xs-2.1", name: "laguna-xs-2.1", description: llama, isDefault: true, efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { id: "plain", name: "Plain", description: llama, isDefault: false, efforts: ["off"] },
      { id: "capped", name: "capped", description: llama, isDefault: false, efforts: ["off", "low", "medium", "high"] },
      { id: "a/dup", name: "Dup (a)", description: "a", isDefault: false, efforts: ["off"] },
      { id: "b/dup", name: "Dup (b)", description: "b", isDefault: false, efforts: ["off"] },
    ],
    modes: [],
  });
});

// --- chat features. Shapes from a live `pi --mode rpc` run (pi 1.1.0, laguna-xs-2.1,
// examples/extensions/todo.ts loaded with -e).

const usage = (input: number, output: number, cacheRead: number, total = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test("user images become ImageData; image data above ~1 MB is omitted", () => {
  const tools = new Map<string, Tool>();
  const small = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABA";
  const items = normalize(
    {
      role: "user",
      content: [
        { type: "text", text: "What colour is this square? One word." },
        { type: "image", data: small, mimeType: "image/png" },
        { type: "image", data: "A".repeat(1_500_000), mimeType: "image/jpeg" },
      ],
      timestamp: 1,
    },
    tools,
    "u1",
  );
  assert.deepEqual(items, [
    {
      kind: "user",
      id: "u1",
      text: "What colour is this square? One word.",
      images: [{ mediaType: "image/png", data: small }, { mediaType: "image/jpeg" }],
    },
  ]);
  // An image-only prompt still shows up.
  assert.deepEqual(normalize({ role: "user", content: [{ type: "image", data: small, mimeType: "image/png" }], timestamp: 2 }, tools, "u2"), [
    { kind: "user", id: "u2", text: "", images: [{ mediaType: "image/png", data: small }] },
  ]);
});

test("todo tool results carry the list as a plan with a stable id", () => {
  const tools = new Map<string, Tool>();
  normalize(assistant(10, [{ type: "toolCall", id: "c1", name: "todo", arguments: { action: "toggle", id: 1 } }], { stopReason: "toolUse" }), tools);
  const items = normalize(
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "todo",
      content: [{ type: "text", text: "Todo #1 completed" }],
      details: { action: "toggle", todos: [{ id: 1, text: "write tests", done: true }, { id: 2, text: "ship it", done: false }], nextId: 3 },
      isError: false,
      timestamp: 11,
    },
    tools,
  );
  assert.deepEqual(items[1], {
    kind: "plan",
    id: "plan:todo",
    entries: [
      { text: "write tests", status: "completed" },
      { text: "ship it", status: "pending" },
    ],
  });
});

test("planEntries accepts the extension todo shapes and rejects anything else", () => {
  assert.deepEqual(planEntries([{ step: 1, text: "a", completed: true }, { content: "b", status: "in-progress" }, { title: "c", status: "done" }]), [
    { text: "a", status: "completed" },
    { text: "b", status: "in_progress" },
    { text: "c", status: "completed" },
  ]);
  assert.deepEqual(planEntries([]), []);
  assert.equal(planEntries(undefined), null);
  assert.equal(planEntries([{ id: 1 }]), null);
  assert.equal(planEntries(["x"]), null);
  // plan-mode extension: pi.appendEntry("plan-mode", { enabled, todos, executing })
  assert.deepEqual(customPlan({ customType: "plan-mode", data: { enabled: false, todos: [{ step: 1, text: "Read code", completed: false }] } }), {
    kind: "plan",
    id: "plan:plan-mode",
    entries: [{ text: "Read code", status: "pending" }],
  });
  assert.equal(customPlan({ customType: "my-ext", data: { count: 42 } }), null);
});

test("history: custom messages and plans; a failed response followed by a retry becomes a warning", () => {
  const jsonl = [
    msg("u1", null, { role: "user", content: "What colour?", timestamp: 1 }),
    msg("a1", "u1", assistant(2, [], { stopReason: "error", errorMessage: "503 overloaded" })),
    msg("a2", "a1", assistant(3, [{ type: "text", text: "Red" }])),
    line({ type: "custom_message", id: "cm", parentId: "a2", timestamp: "t", customType: "plan-mode-execute", content: "Executing plan", display: true }),
    line({ type: "custom_message", id: "cm2", parentId: "cm", timestamp: "t", customType: "hidden", content: "secret", display: false }),
    line({ type: "custom", id: "pm", parentId: "cm2", timestamp: "t", customType: "plan-mode", data: { todos: [{ step: 1, text: "Read", completed: true }] } }),
    msg("a3", "pm", assistant(4, [], { stopReason: "error", errorMessage: "fatal" })),
  ].join("\n");
  assert.deepEqual(parseSession(jsonl), [
    { kind: "user", id: "u1", text: "What colour?" },
    { kind: "notice", id: "2:error", text: "Retried after: 503 overloaded", level: "warning" },
    { kind: "assistant", id: "3:0", text: "Red" },
    { kind: "notice", id: "cm", text: "Executing plan", level: "info" },
    { kind: "plan", id: "plan:plan-mode", entries: [{ text: "Read", status: "completed" }] },
    { kind: "notice", id: "4:error", text: "fatal", level: "error" },
  ]);
});

test("sessionUsage: context from the last valid response, totals over every entry, window from the model list", () => {
  const llama = "llama-server=http://127.0.0.1:8080";
  const a = (ts: number, u: object, extra: Partial<PiMessage> = {}) =>
    assistant(ts, [{ type: "text", text: "x" }], { model: "laguna-xs-2.1", provider: llama, usage: u as PiMessage["usage"], ...extra });
  const jsonl = [
    msg("u1", null, { role: "user", content: "hi", timestamp: 1 }),
    msg("a1", "u1", a(2, usage(14, 40, 3138))),
    msg("a2", "a1", a(3, usage(14, 3, 3525, 0.5))),
    msg("a3", "a2", a(4, usage(0, 0, 0), { stopReason: "aborted" })),
    line({ type: "usage", id: "w", parentId: "a3", timestamp: "t", kind: "cache_warm", provider: llama, model: "laguna-xs-2.1", usage: usage(0, 0, 100, 0.25) }),
  ].join("\n");
  const windows = (p: string, m: string) => (p === llama && m === "laguna-xs-2.1" ? 65536 : undefined);
  assert.deepEqual(sessionUsage(jsonl, windows), {
    model: "laguna-xs-2.1",
    contextTokens: 3542,
    contextWindow: 65536,
    inputTokens: 14 + 3138 + 14 + 3525 + 100,
    outputTokens: 43,
    costUsd: 0.75,
  });
  // After a compaction the context size is unknown until the next response.
  const compacted = jsonl + "\n" + line({ type: "compaction", id: "c", parentId: "w", timestamp: "t", summary: "s", firstKeptEntryId: "a2", tokensBefore: 3542 });
  assert.equal(sessionUsage(compacted)?.contextTokens, undefined);
  assert.equal(sessionUsage(msg("u1", null, { role: "user", content: "hi", timestamp: 1 })), null);
});

test("outputDelta streams the new part of cumulative tool output snapshots", () => {
  assert.equal(outputDelta("", "1\n"), "1\n");
  assert.equal(outputDelta("1\n", "1\n2\n"), "2\n");
  assert.equal(outputDelta("1\n2\n", "1\n2\n"), "");
  // pi keeps the tail once output is large: continue after the previous tail.
  assert.equal(outputDelta("aaaa\nbbbb\n", "bbbb\ncccc\n"), "cccc\n");
});

test("commands: get_commands entries with kinds; argument hints from prompt template frontmatter", () => {
  assert.equal(argumentHint("---\ndescription: Repeat a word in capitals\nargument-hint: <word>\n---\nReply with $1"), "<word>");
  assert.equal(argumentHint('---\nargument-hint: "[focus]"\n---\nx'), "[focus]");
  assert.equal(argumentHint("no frontmatter\nargument-hint: x"), undefined);
  const commands = parseCommands(
    [
      { name: "todos", description: "Show all todos on the current branch", source: "extension", sourceInfo: { path: "/x/todo.ts" } },
      { name: "shout", description: "Repeat a word in capitals", source: "prompt", sourceInfo: { path: "/w/.pi/prompts/shout.md" } },
      { name: "skill:fedora-compute", description: "Use the fedora box", source: "skill" },
      { name: "bare", source: "extension" },
    ],
    new Map([["shout", "<word>"]]),
  );
  assert.deepEqual(commands, [
    { name: "todos", description: "Show all todos on the current branch", kind: "command" },
    { name: "shout", description: "Repeat a word in capitals", argumentHint: "<word>", kind: "command" },
    { name: "skill:fedora-compute", description: "Use the fedora box", kind: "skill" },
    { name: "bare", kind: "command" },
  ]);
});

test("user shell commands (bashExecution) are shell items; non-zero exits and cancels are errors", () => {
  const tools = new Map<string, Tool>();
  const bash = (extra: Partial<PiMessage>): PiMessage => ({ role: "bashExecution", command: "ls", output: "a\n", exitCode: 0, cancelled: false, timestamp: 9, ...extra });
  assert.deepEqual(normalize(bash({}), tools), [{ kind: "tool", id: "9", name: "shell", origin: "user", input: { command: "ls" }, status: "done", output: "a\n" }]);
  assert.equal((normalize(bash({ exitCode: 2 }), tools)[0] as Tool).status, "error");
  assert.equal((normalize(bash({ exitCode: undefined, cancelled: true }), tools)[0] as Tool).status, "error");
  assert.deepEqual(shellItem("x", "true", undefined, 0), { kind: "tool", id: "x", name: "shell", origin: "user", input: { command: "true" }, status: "done", output: "" });
});

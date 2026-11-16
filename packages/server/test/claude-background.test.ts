import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@casm/protocol";
import { Normalizer, historyItems, historyWithOutputs, parseLines, type Entry } from "../src/providers/claude.ts";
import { outputPathAllowed, readOutputTail } from "../src/providers/claude-commands.ts";

// Recorded from Claude Code 2.1.292 (SDK 0.3.296) on a scratch project:
// - orphan: four background Bash calls (one done, one exit 3, one stopped with
//   TaskStop, one still sleeping), notices that each opened a turn, then a new
//   process whose first prompt carried the "didn't finish" orphan notice;
// - monitor: the same with a Monitor, its notices delivered within the turn;
// - live: the SDK messages of the monitor run, as the session receives them.
const fixture = async (name: string) => parseLines(await readFile(join(import.meta.dirname, "fixtures", `claude-background-${name}.jsonl`), "utf8"));
type Tool = Extract<Item, { kind: "tool" }>;
const tools = (items: Item[]) => Object.fromEntries(items.filter((i): i is Tool => i.kind === "tool" && !!i.background)
  .map((i) => [(i.input as { description: string }).description, { status: i.status, ...(i.background!.stopped ? { stopped: true } : {}) }]));

test("stored background commands stay their Bash calls and end as Claude's notices say", async () => {
  const items = historyItems(await fixture("orphan"));
  assert.equal(items.filter((i) => i.kind === "subagent").length, 0);
  assert.deepEqual(tools(items), {
    "Count to five": { status: "done" },
    "Fail with exit 3": { status: "error" },
    "Sleep fifteen minutes": { status: "error", stopped: true },
    "Sleep to be stopped": { status: "error", stopped: true },
  });
  const bash = items.find((i) => i.id === "toolu_01D3fasMktL8Ly4YG4bSygNu") as Tool;
  // The "running in background" placeholder is not the command's output.
  assert.equal(bash.output, undefined);
  assert.equal(bash.background?.taskId, "brmfluvi1");
  assert.equal(bash.endedAt, "2026-11-16T21:54:27.879Z"); // its notice
  // Notices that opened a turn say so; the orphan notice rode along with a prompt.
  assert.deepEqual(items.filter((i) => i.kind === "notice").map((i) => (i as { text: string }).text), [
    'Woken by a background task: Background command "Fail with exit 3" failed with exit code 3',
    'Woken by a background task: Background command "Count to five" completed (exit code 0)',
  ]);
});

test("notices delivered within a turn, Monitor and TaskStop end their commands", async () => {
  const items = historyItems(await fixture("monitor"));
  assert.equal(items.filter((i) => i.kind === "subagent").length, 0);
  assert.deepEqual(tools(items), {
    "Count to eight": { status: "done" },
    "Fail with exit 3": { status: "error" },
    "Sleep to be stopped": { status: "error", stopped: true },
    "Tick twice": { status: "done" },
  });
  const monitor = items.find((i) => i.kind === "tool" && i.name === "Monitor") as Tool;
  assert.equal(monitor.background?.taskId, "bnuxfqrjs");
});

test("live task events update the same Bash cards the history shows", async () => {
  const n = new Normalizer();
  const latest = new Map<string, Item>();
  const statuses: string[] = [];
  for (const m of await fixture("live")) for (const item of n.entry(m as Entry)) {
    latest.set(item.id, item);
    if (item.id === "toolu_013vhwuZyEMfKkAtrgEus8mi" && item.kind === "tool" && statuses.at(-1) !== item.status) statuses.push(item.status);
  }
  const live = [...latest.values()];
  assert.equal(live.filter((i) => i.kind === "subagent").length, 0);
  // The command runs from task_started until its own task events end it.
  assert.deepEqual(statuses, ["running", "done"]);
  const stored = tools(historyItems(await fixture("monitor")));
  assert.deepEqual(tools(live), stored);
});

test("an orphan notice listing several tasks without their calls stops each of them", () => {
  const n = new Normalizer();
  const call = (id: string, command: string) => ({ type: "assistant", uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description: command, timeout: 600000 } }] } });
  // Moved to the background after the foreground timeout (no run_in_background).
  const moved = (id: string, task: string) => ({ type: "user", uuid: `r-${id}`, toolUseResult: { stdout: "", stderr: "", backgroundTaskId: task, timedOutAfterMs: 600000 },
    message: { content: [{ type: "tool_result", tool_use_id: id, content: `Command did not complete within its 600s timeout and was moved to the background (ID: ${task}). Output is being written to: /tmp/claude-1000/-p/s/tasks/${task}.output. You will be notified when it completes.` }] } });
  for (const e of [call("t1", "npm test"), moved("t1", "bomd7yt8z"), call("t2", "npm run e2e"), moved("t2", "bu1x0z72d")]) n.entry(e);
  // Verbatim from a Claude Code 2.1 transcript.
  const content = "<task-notification>\n<task-id>bomd7yt8z</task-id>\n<task-id>bu1x0z72d</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn't finish before the previous session ended. Task ids: bomd7yt8z, bu1x0z72d.</summary>\n<note>No completion record was found for them in the previous session. They may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or they may have been running when the previous Claude Code process exited. They have been marked stopped. Task ids in this notification beginning with \"__orphan_summary\" are internal scan markers, not tasks.</note>\n</task-notification>";
  const items = n.entry({ type: "user", uuid: "orphan", origin: { kind: "task-notification" }, message: { content } });
  assert.deepEqual(items.map((i) => [i.id, i.kind === "tool" && i.status, i.kind === "tool" && i.background]), [
    ["t1", "error", { taskId: "bomd7yt8z", stopped: true }],
    ["t2", "error", { taskId: "bu1x0z72d", stopped: true }],
  ]);
});

test("a foreground command Claude tracks as a task stays a plain tool call", () => {
  const n = new Normalizer();
  n.entry({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test" } }] } });
  assert.deepEqual(n.entry({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t", task_type: "local_bash", is_backgrounded: false, description: "npm test" } as Entry), []);
  const done = n.entry({ type: "user", uuid: "r", toolUseResult: { stdout: "ok" }, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
  assert.deepEqual(done.map((i) => i.kind === "tool" && [i.status, i.output, i.background]), [["done", "ok", undefined]]);
  assert.deepEqual(n.entry({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "t", status: "completed", summary: "" } as Entry), []);
});

test("a background subagent is still a subagent", () => {
  const n = new Normalizer();
  const items = [
    ...n.entry({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Agent", input: { description: "Review", run_in_background: true } }] } }),
    ...n.entry({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "t", task_type: "local_agent", description: "Review" } as Entry),
    ...n.entry({ type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "t", status: "completed", summary: "Looks fine" } as Entry),
  ];
  assert.deepEqual(items.map((i) => [i.kind, i.kind === "subagent" && i.status]), [["subagent", "running"], ["subagent", "done"]]);
});

test("history reads the tail of each command's own output file, and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "casm-bg-"));
  try {
    const session = "c77f4c6d-52bf-455f-87fa-35243be8b79e";
    const dir = join(root, "claude-1000", "-tmp-bgrec-proj", session, "tasks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "brmfluvi1.output"), "line 1\nline 2\nline 3\nline 4\nline 5\n\n[exited with code 0]\n");
    await writeFile(join(root, "secret"), "not for casm");
    await symlink(join(root, "secret"), join(dir, "bgnsrsh52.output"));
    const lines = (await fixture("orphan")).map((l) => JSON.parse(JSON.stringify(l).replaceAll("/tmp/claude-1000", join(root, "claude-1000"))));
    const items = await historyWithOutputs(lines, session);
    const output = (id: string) => (items.find((i) => i.id === id) as Tool).output;
    assert.equal(output("toolu_01D3fasMktL8Ly4YG4bSygNu"), "line 1\nline 2\nline 3\nline 4\nline 5\n\n[exited with code 0]");
    // A symlink is not followed; a missing file (sleep 900's) just has no output.
    assert.equal(output("toolu_01PMqZHkpgX6WR7Spda6aNq1"), undefined);
    assert.equal(output("toolu_018bSEqWPjJDPZxYQms67mrb"), undefined);

    await writeFile(join(dir, "bp7h4vkww.output"), "\n[killed]\n");
    assert.equal(await readOutputTail(join(dir, "bp7h4vkww.output"), session, "bp7h4vkww"), null);
    await writeFile(join(dir, "brmfluvi1.output"), Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n"));
    const tail = await readOutputTail(join(dir, "brmfluvi1.output"), session, "brmfluvi1");
    assert.ok(tail!.startsWith("…\nrow ") && tail!.endsWith("row 4999") && tail!.length <= 16 * 1024 + 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a task's own output file in its session's task directory may be read", () => {
  const ok = "/tmp/claude-1000/-p/s1/tasks/b1.output";
  assert.equal(outputPathAllowed(ok, "s1", "b1"), true);
  assert.equal(outputPathAllowed(ok, "s2", "b1"), false);
  assert.equal(outputPathAllowed(ok, "s1", "b2"), false);
  assert.equal(outputPathAllowed("/tmp/claude-1000/-p/s1/tasks/../../s1/tasks/b1.output", "s1", "b1"), false);
  assert.equal(outputPathAllowed("/home/u/.ssh/s1/tasks/b1.output", "s1", "b1"), false);
  assert.equal(outputPathAllowed("tmp/claude-1000/-p/s1/tasks/b1.output", "s1", "b1"), false);
});

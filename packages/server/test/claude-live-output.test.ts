import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@casm/protocol";
import { Normalizer, parseLines, type Entry } from "../src/providers/claude.ts";
import { findOutputFile, readOutputTail } from "../src/providers/claude-commands.ts";
import { outputDelta } from "../src/providers/output.ts";

// Recorded from Claude Code 2.1.292 (SDK 0.3.296), Haiku running
// `for i in 1 2 3 4 5 6; do echo line $i; sleep 2; done` in the foreground;
// `t` is ms since the query started. Claude wrote
// <tmp>/claude-1000/-tmp-live-probe-proj/<session>/tasks/bvsjh0kwt.output from
// the start (line 1 at 3606 ms, a line every 2 s), sent task_started for that
// task id at 6468 ms (no output_file, no tool_progress), and deleted the file
// right after the tool result (15527 ms).
const fixture = async () => parseLines(await readFile(join(import.meta.dirname, "fixtures", "claude-foreground-live.jsonl"), "utf8"));
const TOOL = "toolu_0144nUSw9otxvzgyGoaxA2N7";

test("a foreground command runs from its task_started to its result", async () => {
  const n = new Normalizer();
  const seen: { at: number; running: string[]; items: Item[] }[] = [];
  for (const m of await fixture()) {
    const items = n.entry(m as Entry);
    seen.push({ at: (m as unknown as { t: number }).t, running: n.runningCommands().map((c) => `${c.id}:${c.taskId}`), items });
  }
  assert.deepEqual(seen.map((s) => [s.at, s.running]), [
    [3394, []],
    [6468, [`${TOOL}:bvsjh0kwt`]],
    [15517, []],
    [15527, []],
  ]);
  // The tool card is the call itself; its result is the whole output.
  const done = seen.at(-1)!.items.find((i) => i.id === TOOL) as Extract<Item, { kind: "tool" }>;
  assert.equal(done.status, "done");
  assert.equal(done.output, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6");
  assert.equal(done.background, undefined);
});

test("a result, the end of the turn, or moving to the background stops following it", () => {
  const start = (n: Normalizer, id: string, task: string) => {
    n.entry({ type: "assistant", uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "make" } }] } });
    n.entry({ type: "system", subtype: "task_started", task_id: task, tool_use_id: id, task_type: "local_bash", is_backgrounded: false } as Entry);
  };
  const n = new Normalizer();
  start(n, "t1", "b1");
  start(n, "t2", "b2");
  start(n, "t3", "b3");
  assert.deepEqual(n.runningCommands().map((c) => c.taskId), ["b1", "b2", "b3"]);
  // Interrupted: the result comes first, an error.
  n.entry({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Interrupted", is_error: true }] } });
  // Moved to the background after its timeout: the background card takes over.
  const moved = n.entry({ type: "system", subtype: "task_updated", task_id: "b2", patch: { is_backgrounded: true } } as Entry);
  assert.equal((moved[0] as Extract<Item, { kind: "tool" }>).background?.taskId, "b2");
  assert.deepEqual(n.runningCommands().map((c) => c.taskId), ["b3"]);
  n.endTurn();
  assert.deepEqual(n.runningCommands(), []);
  // A subagent's task or a finished call never counts.
  n.entry({ type: "assistant", uuid: "a4", message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "true" } }] } });
  n.entry({ type: "user", uuid: "r4", message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "" }] } });
  n.entry({ type: "system", subtype: "task_started", task_id: "b4", tool_use_id: "t4", task_type: "local_bash", is_backgrounded: false } as Entry);
  assert.deepEqual(n.runningCommands(), []);
});

test("the running command's file is found in its session's task folder and streamed as deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "casm-live-"));
  try {
    const uid = process.getuid!();
    const session = "16e9fa81-6af8-473e-a0b7-f8f7d5e3f6f7";
    const dir = join(root, `claude-${uid}`, "-tmp-live-probe-proj", session, "tasks");
    assert.equal(await findOutputFile(session, "bvsjh0kwt", [root]), null);
    await mkdir(join(root, `claude-${uid}`, "-other-project", "another-session", "tasks"), { recursive: true });
    await mkdir(dir, { recursive: true });
    const file = join(dir, "bvsjh0kwt.output");
    await writeFile(file, "line 1\n");
    assert.equal(await findOutputFile(session, "bvsjh0kwt", [undefined, join(root, "missing"), root]), file);
    assert.equal(await findOutputFile("another-session", "bvsjh0kwt", [root]), null);
    assert.equal(await findOutputFile(session, "../bvsjh0kwt", [root]), null);

    // Each read sends what is new since the last one.
    let sent = "";
    const deltas: string[] = [];
    const read = async () => {
      const text = await readOutputTail(file, session, "bvsjh0kwt");
      if (!text) return;
      const d = outputDelta(sent, text);
      sent = text;
      if (d) deltas.push(d);
    };
    await read();
    await read();
    await appendFile(file, "line 2\nline 3\n");
    await read();
    assert.deepEqual(deltas, ["line 1", "\nline 2\nline 3"]);
    assert.equal(deltas.join(""), "line 1\nline 2\nline 3");

    // Past the tail limit, only lines after what was sent follow.
    await appendFile(file, Array.from({ length: 4000 }, (_, i) => `row ${i}`).join("\n") + "\n");
    await read();
    assert.ok(deltas.at(-1)!.startsWith("\nrow 0\n") || deltas.at(-1)!.startsWith("…\n"));
    assert.ok(deltas.at(-1)!.endsWith("row 3999"));
    await appendFile(file, "last\n");
    await read();
    assert.equal(deltas.at(-1), "\nlast");

    // Deleted when the command ends: nothing more to read.
    await rm(file);
    assert.equal(await readOutputTail(file, session, "bvsjh0kwt"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

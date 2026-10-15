import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import { isoTime, timed, TimedItems } from "../src/item-times.ts";
import { historyItems } from "../src/providers/claude.ts";
import { parseSession } from "../src/providers/pi.ts";
import { normalizeMessages, type OcMessage } from "../src/providers/opencode.ts";

const T1 = "2026-10-15T10:24:27.000Z";
const T2 = "2026-10-15T10:34:05.000Z";
const tool = (status: "running" | "done"): Item => ({ kind: "tool", id: "t", name: "Bash", input: {}, status });

test("an upserted item keeps its first time; a tool that finishes later gets endedAt", () => {
  const items = new TimedItems();
  items.put(tool("running"), T1);
  assert.deepEqual(items.put(tool("done"), T2), { ...tool("done"), at: T1, endedAt: T2 });
  // Done in one go: no end unless the provider recorded one.
  assert.deepEqual(timed(undefined, tool("done"), T1), { ...tool("done"), at: T1 });
  assert.deepEqual(timed(undefined, tool("done"), T1, T2), { ...tool("done"), at: T1, endedAt: T2 });
  // Nothing recorded: no time is made up.
  assert.deepEqual(timed(undefined, tool("running")), tool("running"));
  assert.equal(isoTime("not a date"), undefined);
  assert.equal(isoTime(Date.parse(T1)), T1);
});

test("Claude history dates entries from the transcript's timestamps", () => {
  const items = historyItems([
    { type: "user", uuid: "u", timestamp: T1, message: { role: "user", content: "run the tests" } },
    { type: "assistant", uuid: "a", parentUuid: "u", timestamp: T1, message: { id: "m", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", uuid: "r", parentUuid: "a", timestamp: T2, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } },
  ] as Parameters<typeof historyItems>[0]);
  const run = items.find((i) => i.kind === "tool");
  assert.equal(items.find((i) => i.kind === "user")?.at, T1);
  assert.deepEqual(run && run.kind === "tool" && [run.at, run.endedAt], [T1, T2]);
});

test("pi history dates entries from each entry's timestamp", () => {
  const lines = [
    { type: "message", id: "1", parentId: null, timestamp: T1, message: { role: "user", content: "hi" } },
    { type: "message", id: "2", parentId: "1", timestamp: T1, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", id: "3", parentId: "2", timestamp: T2, message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a" }] } },
  ];
  const items = parseSession(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(items[0].at, T1);
  const run = items.find((i) => i.kind === "tool");
  assert.deepEqual(run && run.kind === "tool" && [run.at, run.endedAt], [T1, T2]);
});

test("OpenCode history dates messages by creation and tools by their own start and end", () => {
  const ms = (t: string) => Date.parse(t);
  const messages = [
    { info: { id: "msg_u", sessionID: "s", role: "user", time: { created: ms(T1) } }, parts: [{ id: "p1", sessionID: "s", messageID: "msg_u", type: "text", text: "hi" }] },
    { info: { id: "msg_a", sessionID: "s", role: "assistant", parentID: "msg_u", time: { created: ms(T1) } }, parts: [
      { id: "p2", sessionID: "s", messageID: "msg_a", type: "tool", tool: "bash", callID: "c", state: { status: "completed", input: { command: "ls" }, output: "a", time: { start: ms(T1), end: ms(T2) } } },
    ] },
  ] as OcMessage[];
  const items = normalizeMessages(messages);
  assert.equal(items[0].at, T1);
  const run = items.find((i) => i.kind === "tool");
  assert.deepEqual(run && run.kind === "tool" && [run.at, run.endedAt], [T1, T2]);
});

test("Codex history dates items from startedAtMs and completedAtMs", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readHistory } = await import("../src/providers/codex.ts");
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-times-"));
  const entries = [
    { turnId: "t", item: { type: "agentMessage", id: "m", text: "hello" }, startedAtMs: Date.parse(T1), completedAtMs: Date.parse(T1) },
    { turnId: "t", item: { type: "commandExecution", id: "c", command: "npm test", status: "completed", aggregatedOutput: "ok", exitCode: 0 }, startedAtMs: Date.parse(T1), completedAtMs: Date.parse(T2) },
  ];
  writeFileSync(join(dir, "codex.cjs"), `#!${process.execPath}
const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='thread/items/list')result={data:${JSON.stringify(entries)},nextCursor:null};
 if(m.method==='thread/turns/list')result={data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o755 });
  const saved = process.env.CASM_CODEX_PATH;
  process.env.CASM_CODEX_PATH = join(dir, "codex.cjs");
  try {
    const items = await readHistory("thread", dir);
    assert.equal(items.find((i) => i.kind === "assistant")?.at, T1);
    const run = items.find((i) => i.kind === "tool");
    assert.deepEqual(run && run.kind === "tool" && [run.at, run.endedAt], [T1, T2]);
  } finally {
    if (saved === undefined) delete process.env.CASM_CODEX_PATH; else process.env.CASM_CODEX_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

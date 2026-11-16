import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@casm/protocol";
import { readHistory } from "../src/providers/codex.ts";
import { normalizeMessages } from "../src/providers/opencode.ts";
import { parseSession } from "../src/providers/pi.ts";

// One prompt, recorded on each provider: start `for i in 1 2 3 4 5 6; do echo
// tick $i; sleep 2; done; echo done` in the background, then list ./src with a
// subagent (codex-cli 0.160.1, OpenCode 1.19.0 and pi 1.1.0, gpt-6-astra).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const cards = (items: Item[]) => items.flatMap((i) =>
  i.kind === "subagent" ? [["subagent", i.title, i.status, !!i.summary]] : i.kind === "tool" ? [[i.name, i.status, !!i.background]] : []);

test("Codex: the spawned child is a subagent with its answer; its unified-exec command stays a shell", async () => {
  // thread/items/list pages of the parent and of the child thread.
  const pages: Record<string, unknown> = JSON.parse(fixture("codex-subagent-unified-exec.json"));
  const dir = mkdtempSync(join(tmpdir(), "casm-codex-bg-"));
  const old = process.env.CASM_CODEX_PATH;
  const binary = join(dir, "codex.cjs");
  writeFileSync(binary, `#!${process.execPath}
const pages=${JSON.stringify(pages)};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='thread/items/list')result=pages[m.params.threadId]??{data:[],nextCursor:null};
 if(m.method==='thread/turns/list')result={data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o755 });
  process.env.CASM_CODEX_PATH = binary;
  try {
    const items = await readHistory(Object.keys(pages)[0]!, dir);
    assert.deepEqual(cards(items), [
      ["subagent", "/root/list_src", "done", true],
      ["shell", "done", false],
    ]);
    const child = items.find((i) => i.kind === "subagent") as Extract<Item, { kind: "subagent" }>;
    // Live, the child's final message is the card's summary; history reads it too.
    assert.equal(child.summary, "Files in `./src`: `a.txt`, `b.txt`, `c.txt`.");
    const shell = items.find((i) => i.kind === "tool") as Extract<Item, { kind: "tool" }>;
    assert.equal(shell.output, "tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ntick 6\ndone\n");
  } finally {
    if (old === undefined) delete process.env.CASM_CODEX_PATH;
    else process.env.CASM_CODEX_PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode: the task tool is a subagent with its answer; it has no background shell", () => {
  const { messages } = JSON.parse(fixture("opencode-task-subagent.json"));
  assert.deepEqual(cards(normalizeMessages(messages)), [["subagent", "List src files", "done", true]]);
});

test("pi: no subagents or background shell; child agents it starts with casm are bash calls", () => {
  const items = parseSession(fixture("pi-casm-children.jsonl"));
  assert.equal(items.some((i) => i.kind === "subagent"), false);
  const commands = items.flatMap((i) => (i.kind === "tool" ? [String((i.input as { command?: string }).command).split(" ").slice(0, 2).join(" ")] : []));
  assert.deepEqual(commands, ["casm run", "casm wait", "casm run", "casm wait"]);
});

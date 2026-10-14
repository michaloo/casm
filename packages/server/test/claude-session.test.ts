import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProvider } from "../src/providers/claude.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

// Polls until `ready` holds; throws after 5 s so a broken session fails instead of hanging.
async function until(ready: () => boolean) {
  for (const deadline = Date.now() + 5000; !ready(); await new Promise((r) => setTimeout(r, 20)))
    if (Date.now() > deadline) throw new Error("timed out waiting");
}


test("Claude sessions ask for summarized thinking, so Thinking rows have text", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-thinking-"));
  const binary = join(dir, "fake-claude");
  const argsFile = join(dir, "args.json");
  const oldPath = process.env.CASM_CLAUDE_PATH;
  // Records its arguments and exits; the session closing afterwards is expected.
  writeFileSync(binary, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });
  process.env.CASM_CLAUDE_PATH = binary;
  const closed = Promise.withResolvers<void>();
  const session = claudeProvider().open({
    cwd: dir, config: { model: "haiku" }, resumeId: null,
    emit: (e) => { if (e.type === "closed") closed.resolve(); },
    askPermission: async () => { throw new Error("unexpected permission"); },
    askQuestion: async () => { throw new Error("unexpected question"); },
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CLAUDE_PATH;
    else process.env.CASM_CLAUDE_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("hi", "user-1");
  await until(() => existsSync(argsFile));
  const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.ok(args.includes("--thinking=adaptive"), args.join(" "));
  assert.ok(args.includes("--thinking-display=summarized"), args.join(" "));
});

test("Claude sessions report the model from system/init as the effective model", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-model-"));
  const binary = join(dir, "fake-claude");
  const oldPath = process.env.CASM_CLAUDE_PATH;
  // Answers control requests and replies to the first user message with system/init.
  writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') write({type: 'control_response', response: {subtype: 'success', request_id: m.request_id, response: {}}});
  if (m.type === 'user') write({type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-opus-5-5', uuid: 'init-1',
    cwd: ${JSON.stringify(dir)}, tools: [], mcp_servers: [], permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default'});
});
`, { mode: 0o755 });
  process.env.CASM_CLAUDE_PATH = binary;
  const events: ProviderEvent[] = [];
  const session = claudeProvider().open({
    cwd: dir, config: {}, resumeId: null,
    emit: (e) => events.push(e),
    askPermission: async () => { throw new Error("unexpected permission"); },
    askQuestion: async () => { throw new Error("unexpected question"); },
  });
  t.after(async () => {
    await session.close();
    if (oldPath === undefined) delete process.env.CASM_CLAUDE_PATH;
    else process.env.CASM_CLAUDE_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  session.send("hi", "user-1");
  await until(() => events.some((e) => e.type === "model"));
  assert.deepEqual(events.find((e) => e.type === "model"), { type: "model", model: "claude-opus-5-5" });
  assert.ok(events.some((e) => e.type === "sessionId" && e.id === "native-1"));
});

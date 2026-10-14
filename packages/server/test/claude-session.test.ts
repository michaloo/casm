import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("Claude sessions get their id up front; a session Claude never stored starts anew under the same id", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-session-id-"));
  const binary = join(dir, "fake-claude");
  const old = { path: process.env.CASM_CLAUDE_PATH, config: process.env.CLAUDE_CONFIG_DIR };
  writeFileSync(binary, `#!${process.execPath}
require('node:fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });
  process.env.CASM_CLAUDE_PATH = binary;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "config");
  t.after(() => {
    for (const [k, v] of [["CASM_CLAUDE_PATH", old.path], ["CLAUDE_CONFIG_DIR", old.config]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  const open = async (name: string, resumeId: string | null) => {
    const argsFile = join(dir, `${name}.json`);
    const events: ProviderEvent[] = [];
    const session = claudeProvider().open({
      cwd: dir, config: { env: { ARGS_FILE: argsFile } }, resumeId,
      emit: (e) => events.push(e),
      askPermission: async () => { throw new Error("unexpected permission"); },
      askQuestion: async () => { throw new Error("unexpected question"); },
    });
    await Promise.resolve();
    // Known before the process has even started.
    const early = events.filter((e) => e.type === "sessionId");
    session.send("hi", "user-1");
    await until(() => existsSync(argsFile));
    await session.close();
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
    // "--flag=value" or "--flag value".
    const flag = (f: string) => args.find((x) => x.startsWith(`${f}=`))?.slice(f.length + 1) ?? (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
    return { early, events, sessionId: flag("--session-id"), resume: flag("--resume") };
  };

  const fresh = await open("fresh", null);
  assert.match(fresh.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(fresh.early, [{ type: "sessionId", id: fresh.sessionId }]);
  assert.equal(fresh.resume, undefined);

  const stored = "11111111-1111-4111-8111-111111111111";
  const projectDir = join(dir, "config", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${stored}.jsonl`), "");
  const resumed = await open("resumed", stored);
  assert.deepEqual([resumed.resume, resumed.sessionId, resumed.early], [stored, undefined, []]);

  const lost = "22222222-2222-4222-8222-222222222222";
  const anew = await open("anew", lost);
  assert.deepEqual([anew.resume, anew.sessionId], [undefined, lost]);
  assert.ok(anew.events.some((e) => e.type === "item" && e.item.kind === "notice" && e.item.text.includes("no stored conversation")));
});

test("usage read from the store gets the context window from Claude Code once per model", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "casm-claude-window-"));
  const binary = join(dir, "fake-claude");
  const spawns = join(dir, "spawns");
  const old = { path: process.env.CASM_CLAUDE_PATH, config: process.env.CLAUDE_CONFIG_DIR };
  // Answers get_context_usage with a window per --model; counts its starts.
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(spawns)}, 'x');
const model = (process.argv.find(a => a.startsWith('--model=')) ?? '').slice(8) || process.argv[process.argv.indexOf('--model') + 1];
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type !== 'control_request') return;
  const response = m.request.subtype === 'get_context_usage'
    ? {categories: [], totalTokens: 0, maxTokens: 1, rawMaxTokens: model === 'big-model' ? 1000000 : 200000, percentage: 0, gridRows: [], model, memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true}
    : {};
  write({type: 'control_response', response: {subtype: 'success', request_id: m.request_id, response}});
});
`, { mode: 0o755 });
  process.env.CASM_CLAUDE_PATH = binary;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "config");
  t.after(() => {
    for (const [k, v] of [["CASM_CLAUDE_PATH", old.path], ["CLAUDE_CONFIG_DIR", old.config]] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  const projectDir = join(dir, "config", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const session = (id: string, model: string) =>
    writeFileSync(join(projectDir, `${id}.jsonl`), JSON.stringify({ type: "assistant", uuid: "a", message: { model, role: "assistant", content: [], usage: { input_tokens: 5000 } } }) + "\n");
  session("s1", "big-model");
  session("s2", "big-model");
  session("s3", "small-model");
  const provider = claudeProvider();
  assert.deepEqual(await provider.usage("s1", dir), { model: "big-model", contextTokens: 5000, contextWindow: 1000000 });
  assert.equal((await provider.usage("s2", dir))?.contextWindow, 1000000);
  assert.equal((await provider.usage("s3", dir))?.contextWindow, 200000);
  // Once per model.
  assert.equal(readFileSync(spawns, "utf8").length, 2);
});

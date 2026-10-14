import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProvider } from "../src/providers/claude.ts";

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
  while (!existsSync(argsFile)) await new Promise((r) => setTimeout(r, 20));
  const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.ok(args.includes("--thinking=adaptive"), args.join(" "));
  assert.ok(args.includes("--thinking-display=summarized"), args.join(" "));
});

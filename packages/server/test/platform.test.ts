import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import spawn from "cross-spawn";
import { findExecutable, shellCommand, killProcessTree, codexExecutable } from "../src/platform.ts";
import { searchFiles } from "../src/fs-search.ts";

test("desktop discovery skips incomplete updates and rechecks bundles on every launch", () => {
  const root = mkdtempSync(join(tmpdir(), "casm desktop bundles "));
  const env = { CASM_CODEX_BIN_DIR: root, CASM_CODEX_PATH: "obsolete.exe" };
  const bundle = (name: string, time: number, complete = true) => {
    const dir = join(root, name);
    mkdirSync(dir);
    const exe = join(dir, "codex.exe");
    writeFileSync(exe, "test");
    utimesSync(exe, time, time);
    if (complete) writeFileSync(join(dir, "codex-code-mode-host.exe"), "test");
    return exe;
  };
  try {
    assert.throws(() => codexExecutable(env), /No complete Codex/);
    const old = bundle("old", 100);
    const next = bundle("next", 200, false);
    assert.equal(codexExecutable(env), old);
    writeFileSync(join(root, "next", "codex-code-mode-host.exe"), "test");
    assert.equal(codexExecutable(env), next);
    rmSync(join(root, "next", "codex-code-mode-host.exe"));
    assert.equal(codexExecutable(env), old);
    assert.equal(codexExecutable({ CASM_CODEX_PATH: "custom" }), "custom");
    assert.equal(codexExecutable({}), "codex");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("program discovery handles spaces, missing programs and Windows PATHEXT", () => {
  const dir = mkdtempSync(join(tmpdir(), "casm program path "));
  try {
    const file = join(dir, process.platform === "win32" ? "agent.cmd" : "agent");
    writeFileSync(file, "", { mode: 0o755 });
    const env = { Path: dir, PATHEXT: ".EXE;.CMD" };
    assert.equal(findExecutable("agent", env)?.toLowerCase(), file.toLowerCase());
    assert.equal(findExecutable("missing", env), undefined);
    assert.equal(findExecutable(file, env), file);
    mkdirSync(join(dir, "directory"));
    assert.equal(findExecutable(join(dir, "directory"), env), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows npm shim preserves arguments without executing shell metacharacters", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "casm shim path "));
  try {
    const script = join(dir, "args.cjs");
    const shim = join(dir, "agent.cmd");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0args.cjs" %*\r\n`);
    const args = ["a b", "literal&echo BAD", 'a"quoted"value', "file>other", "pipe|text"];
    const result = spawn.sync(shim, args, { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native explicit shell executes a command", () => {
  const [shell, args] = shellCommand(process.platform === "win32" ? "Write-Output CASM_OK" : "printf CASM_OK");
  const result = spawn.sync(shell, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "CASM_OK");
});

test("cancellation terminates a running process and its descendant", { timeout: 15000 }, async () => {
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`;
  const proc = nodeSpawn(process.execPath, ["-e", source], { detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(proc, "close");
  let childPid: number | undefined;
  try {
    const [data] = await once(proc.stdout!, "data");
    childPid = Number(data.toString().trim());
    assert.ok(childPid > 0);
    const started = performance.now();
    killProcessTree(proc, "SIGKILL");
    assert.ok(performance.now() - started < 500, "process cleanup blocked the server event loop");
    await closed;
    // Windows may briefly retain a terminated process object.
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(childPid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("descendant still running after cancellation");
  } finally {
    killProcessTree(proc, "SIGKILL");
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
  }
});

test("file search returns slash-separated files and directories on every host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm search "));
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "example.ts"), "");
    const result = await searchFiles(dir, "nested");
    assert.ok(result.some(item => item.path === "nested" && item.kind === "dir"));
    assert.ok(result.some(item => item.path === "nested/example.ts" && item.kind === "file"));
    assert.ok(result.every(item => !/[\\\r]/.test(item.path)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

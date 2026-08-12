import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { interactive, LOCAL } from "./nodes.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "casm.mjs");

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "casm-test-"));
  try {
    return spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("value options support equals syntax", () => {
  const r = run(["list", "--agent=definitely-invalid", "--local"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown agent 'definitely-invalid'/);
});

test("value options reject a missing value", () => {
  const r = run(["list", "--agent", "--local"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /option '--agent'.*needs a value/);
});

test("integer options reject malformed values", () => {
  const r = run(["list", "-n", "nope", "--local"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /option '-n' needs a non-negative integer/);
});

test("boolean options reject assigned values", () => {
  const r = run(["new", "--containerized=true"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /option '--containerized'.*does not take a value/);
});

test("auth with no container records does not require Docker", () => {
  const r = run(["auth"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no containerized sessions/);
});

test("interactive propagates spawn failures", () => {
  assert.throws(
    () => interactive(LOCAL, ["casm-command-that-does-not-exist"], root),
    /ENOENT/,
  );
});

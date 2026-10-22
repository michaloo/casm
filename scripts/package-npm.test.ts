import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("the npm tarball works outside the workspace", { timeout: 180_000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "casm-npm-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CASM_")) delete env[key];
  Object.assign(env, { HOME: join(temp, "home"), CASM_HOME: join(temp, "state"), XDG_CONFIG_HOME: join(temp, "config") });
  delete env.NODE_ENV;
  mkdirSync(env.HOME!, { recursive: true });
  const run = (file: string, args: string[], extra: Record<string, string> = {}) =>
    exec(file, args, { cwd: temp, env: { ...env, ...extra }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const pack = JSON.parse((await run("npm", ["pack", join(root, "dist/npm"), "--json", "--pack-destination", temp])).stdout)[0];
  const files = pack.files.map((f: { path: string }) => f.path);
  assert(files.includes("packages/web/dist/index.html"));
  assert(files.includes("packages/server/src/providers/pi-extension.js"));
  assert(files.includes("packages/server/src/providers/opencode-plugin.js"));
  assert(!files.some((f: string) => !f.startsWith("node_modules/") && (f.endsWith(".ts") || f.includes(".test."))));
  assert(files.includes("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  const prefix = join(temp, "prefix");
  await run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(temp, pack.filename)]);
  const cli = join(prefix, "bin/casm");
  const installed = join(prefix, "lib/node_modules/casm-cli");
  assert(realpathSync(installed).startsWith(temp));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  // Claude Code comes from PATH, like the other providers: no bundled native binary.
  assert.deepEqual(readdirSync(join(installed, "node_modules/@anthropic-ai")).filter(n => n.startsWith("claude-agent-sdk-")), []);

  await t.test("CLI version, help and runtime imports", async () => {
    assert.equal((await run(cli, ["--version"])).stdout.trim(), manifest.version);
    assert.match((await run(cli, ["--help"])).stdout, /casm/);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    for (const file of walk(join(installed, "packages")).filter(f => f.endsWith(".js") && !f.includes("/web/"))) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["']@casm\//, file);
      assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["'][^"']+\.ts["']/, file);
    }
  });

  await t.test("compiled pi extension and OpenCode plugin execute", async () => {
    // Run separately so provider helper environment/global state cannot leak.
    const helpers = join(installed, "packages/server/src/providers");
    const script = `
      import assert from 'node:assert/strict';
      import pi from ${JSON.stringify(pathToFileURL(join(helpers, "pi-extension.js")).href)};
      import opencode from ${JSON.stringify(pathToFileURL(join(helpers, "opencode-plugin.js")).href)};
      process.env.CASM_PI_MCP_SERVERS = JSON.stringify({ test: { command: 'example' } });
      const registrations = [];
      pi({ registerMcpServer: (...args) => registrations.push(args), registerCommand() {}, on() {} });
      assert.equal(registrations[0][0], 'test');
      assert.equal(process.env.CASM_PI_MCP_SERVERS, undefined);
      process.env.CASM_OPENCODE_STATE = ${JSON.stringify(join(temp, "plugin-state"))};
      const hooks = await opencode({ serverUrl: new URL('http://127.0.0.1:1'), directory: '/tmp' });
      const output = { env: {} };
      await hooks['shell.env']({ sessionID: 'session-test', cwd: '/tmp' }, output);
      assert.equal(output.env.PACKAGE_TEST, 'yes');
    `;
    mkdirSync(join(temp, "plugin-state"));
    writeFileSync(join(temp, "plugin-state/session-test.json"), JSON.stringify({ env: { PACKAGE_TEST: "yes" } }));
    await run(process.execPath, ["--input-type=module", "-e", script]);
  });

  await t.test("isolated server, authenticated CLI and built web assets", async () => {
    const child = spawn(cli, ["serve", "--listen", "127.0.0.1:0"], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stdout.on("data", b => { logs += b; });
    child.stderr.on("data", b => { logs += b; });
    const exited = once(child, "exit");
    try {
      const local = join(env.CASM_HOME!, "local.json");
      for (let i = 0; i < 200 && !existsSync(local) && child.exitCode === null; i++)
        await new Promise(r => setTimeout(r, 50));
      assert(existsSync(local), logs);
      const { url } = JSON.parse(readFileSync(local, "utf8"));
      const base = url.replace(/^ws:/, "http:");
      const info = JSON.parse((await run(cli, ["--json", "info"])).stdout);
      assert.equal(info.version, manifest.version);
      assert.deepEqual(JSON.parse((await run(cli, ["--json", "projects"])).stdout), []);
      const response = await fetch(base);
      assert.equal(response.status, 200);
      const html = await response.text();
      const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
      assert(asset, html);
      assert.equal((await fetch(new URL(asset, base))).status, 200);
      assert.equal((await fetch(new URL("/manifest.webmanifest", base))).status, 200);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });

  await t.test("service files reference installed JavaScript on Linux and macOS", async () => {
    const bin = join(temp, "fake-bin");
    mkdirSync(bin);
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    for (const name of ["systemctl", "sleep", "plutil"]) stub(name, "exit 0");
    stub("loginctl", "echo yes");
    stub("launchctl", "if [ \"$1\" = print ]; then echo 'state = running'; fi\nexit 0");
    stub("uname", "echo \"$TEST_OS\"");
    const extra = { PATH: `${bin}:${process.env.PATH}`, TEST_OS: "Linux" };
    await run(cli, ["service", "install"], extra);
    const unit = readFileSync(join(env.XDG_CONFIG_HOME!, "systemd/user/casm.service"), "utf8");
    assert(unit.includes(join(installed, "packages/cli/src/main.js")));
    assert(unit.includes(process.execPath));
    assert(!unit.includes("main.ts"));
    await run(cli, ["service", "install"], { ...extra, TEST_OS: "Darwin" });
    const plist = readFileSync(join(env.HOME!, "Library/LaunchAgents/dev.casm.server.plist"), "utf8");
    assert(plist.includes(join(installed, "packages/cli/src/main.js")));
    assert(!plist.includes("main.ts"));
  });
});

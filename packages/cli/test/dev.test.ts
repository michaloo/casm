import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcher = fileURLToPath(new URL("../../../scripts/dev.ts", import.meta.url));
const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 15_000 });

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  return String(address.port);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}

async function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [launcher, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error(`startup timed out: ${output}`)), 15_000);
      const exited = () => finish(new Error(`server exited: ${output}`));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("exit", exited);
        child.off("error", finish);
        child.stderr!.off("data", data);
        if (error) reject(error); else resolve();
      };
      const data = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("listening on ws://")) finish();
      };
      child.stderr!.on("data", data);
      child.once("exit", exited);
      child.once("error", finish);
    });
    return child;
  } catch (error) {
    await stop(child);
    throw error;
  }
}

test("dev launcher refuses production aliases and service management", (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-dev-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = join(root, "alias");
  symlinkSync(root, alias);
  for (const home of [root, alias]) {
    const result = run({ ...process.env, CASM_HOME: root, CASM_DEV_HOME: home }, "init");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must differ/);
    assert.equal(existsSync(join(root, "casm.db")), false);
  }
  const result = run({ ...process.env, CASM_DEV_HOME: join(root, "dev") }, "service", "restart");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /never manages services/);
  assert.equal(existsSync(join(root, "dev")), false);
});

test("dev routing and restart stay isolated from a second server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-dev-live-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(stop));
    rmSync(root, { recursive: true, force: true });
  });
  const stableHome = join(root, "stable");
  const devHome = join(root, "dev");
  const stablePort = await freePort();
  let devPort = await freePort();
  while (devPort === stablePort) devPort = await freePort();
  const stableEnv = { ...process.env, CASM_DEV_HOME: stableHome, CASM_DEV_PORT: stablePort };
  const first = run(stableEnv, "init");
  assert.equal(first.status, 0, first.stderr);
  children.push(await start(stableEnv));
  const stableCredential = readFileSync(join(stableHome, "development.json"), "utf8");
  const devEnv = {
    ...process.env, CASM_DEV_HOME: devHome, CASM_DEV_PORT: devPort,
    CASM_HOME: stableHome, CASM_URL: `ws://127.0.0.1:${stablePort}`,
    CASM_TOKEN: JSON.parse(stableCredential).token, CASM_HOST: "production",
    CASM_LISTEN: `127.0.0.1:${stablePort}`, CASM_NAME: "production",
    CASM_SERVER_ID: "production-server", CASM_AGENT_ID: "production-agent",
  };
  const init = run(devEnv, "init");
  assert.equal(init.status, 0, init.stderr);
  const credential = readFileSync(join(devHome, "development.json"), "utf8");
  assert.equal(statSync(join(devHome, "development.json")).mode & 0o777, 0o600);
  assert.equal(run(devEnv, "init").status, 0);
  assert.equal(readFileSync(join(devHome, "development.json"), "utf8"), credential);
  const dev = await start(devEnv);
  children.push(dev);
  const created = run(devEnv, "--json", "project", "create", root, "--name", "dev-only");
  assert.equal(created.status, 0, created.stderr);
  const devProjects = run(devEnv, "--json", "projects");
  assert.equal(devProjects.status, 0, devProjects.stderr);
  assert.match(devProjects.stdout, /dev-only/);
  const stableProjects = run(stableEnv, "--json", "projects");
  assert.equal(stableProjects.status, 0, stableProjects.stderr);
  assert.doesNotMatch(stableProjects.stdout, /dev-only/);
  // Sends go now; later is "schedule add --at".
  const later = run(devEnv, "send", "someone", "hi", "--at", "in 2h");
  assert.equal(later.status, 1);
  assert.match(later.stderr, /send has no --at; for later, schedule it: casm schedule add --at "in 2h" --agent someone/);
  assert.match(run(devEnv, "schedules").stdout, /no schedules/);
  const added = run(devEnv, "schedule", "add", "--every", "30m", "--project", "dev-only", "--provider", "codex", "--name", "digest", "daily digest");
  assert.equal(added.status, 0, added.stderr);
  assert.match(run(devEnv, "schedules", "--project", "dev-only").stdout, /^\w+ {2}dev-only {2}digest {2}every 30m {2}new codex agent/m);
  const health = await fetch(`http://127.0.0.1:${devPort}/health`).then((r) => r.json()) as { name: string; id: string };
  assert.equal(health.name, "casm-dev");
  await stop(dev);
  assert.equal((await fetch(`http://127.0.0.1:${stablePort}/health`)).status, 200);
  children.push(await start(devEnv));
  const restarted = await fetch(`http://127.0.0.1:${devPort}/health`).then((r) => r.json()) as { id: string };
  assert.equal(restarted.id, health.id);
  assert.match(run(devEnv, "--json", "projects").stdout, /dev-only/);
  assert.equal(readFileSync(join(stableHome, "development.json"), "utf8"), stableCredential);
});

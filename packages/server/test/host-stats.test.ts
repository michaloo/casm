import { test } from "node:test";
import assert from "node:assert/strict";
import { HostSampler, cpuPercent, cpuTimes, parseMeminfo, parseVmStat } from "../src/host-stats.ts";

const core = (user: number, sys: number, idle: number) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

test("cpuPercent is the busy share of the time delta across all cores", () => {
  const a = cpuTimes([core(100, 50, 850), core(0, 0, 1000)]);
  const b = cpuTimes([core(200, 100, 900), core(50, 0, 1050)]); // delta: busy 200 of 300 total
  assert.equal(cpuPercent(a, b), 66.7);
  assert.equal(cpuPercent(a, a), null);
  assert.equal(cpuPercent(a, cpuTimes([core(100, 50, 950), core(0, 0, 1100)])), 0);
});

test("parseMeminfo uses MemAvailable, not MemFree, and derives swap used", () => {
  const text = `MemTotal:       16000000 kB
MemFree:          500000 kB
MemAvailable:    9000000 kB
Buffers:          100000 kB
Cached:          6000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
`;
  assert.deepEqual(parseMeminfo(text), { total: 16000000 * 1024, available: 9000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 500000 * 1024 });
  const old = parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n");
  assert.equal(old?.available, 300 * 1024);
  assert.equal(old?.swapTotal, 0);
  assert.equal(parseMeminfo("garbage"), null);
});

test("parseVmStat counts free + inactive + speculative pages", () => {
  const text = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             5000.
Pages inactive:                           2000.
Pages speculative:                         500.
`;
  assert.equal(parseVmStat(text), 3500 * 16384);
  assert.equal(parseVmStat("nope"), null);
});

test("HostSampler samples twice on the first call, then reports the delta since the last one", async () => {
  const sampler = new HostSampler();
  const started = Date.now();
  const first = await sampler.read(3);
  assert.ok(Date.now() - started >= HostSampler.GAP_MS - 20, "first call waits for a second sample");
  assert.ok(first.cpuPercent !== null && first.cpuPercent >= 0 && first.cpuPercent <= 100);
  assert.equal(first.runningAgents, 3);
  await new Promise((r) => setTimeout(r, 300));
  const t = Date.now();
  const second = await sampler.read(0);
  assert.ok(Date.now() - t < HostSampler.GAP_MS, "a later call uses the stored snapshot and returns at once");
  assert.ok(second.cpuPercent !== null);
});

test("host.stats over RPC and `casm stats` / `casm host stats` print it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { CasmClient } = await import("@casm/client");
  const { Store } = await import("../src/db.ts");
  const { startServer } = await import("../src/server.ts");
  const dir = mkdtempSync(join(tmpdir(), "casm-stats-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const stats = await client.call("host.stats", {});
    assert.ok(stats.cores >= 1);
    assert.ok(stats.memory.total > 0 && stats.memory.used <= stats.memory.total);
    assert.ok(stats.processRss > 0);
    assert.equal(stats.runningAgents, 0);
    const cli = join(import.meta.dirname, "../../cli/src/main.ts");
    const env = { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "" };
    const exec = (...a: string[]) => promisify(execFile)(process.execPath, [cli, ...a], { env }).then((r) => r.stdout);
    const text = await exec("host", "stats");
    assert.match(text, /^cpu .* cores$/m);
    assert.match(text, /^memory .* available$/m);
    assert.deepEqual(Object.keys(JSON.parse(await exec("stats", "--json"))).sort(), Object.keys(stats).sort());
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

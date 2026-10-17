// provider.costs: per-day estimated cost from pi session files and OpenCode
// sessions, with days bucketed locally, zero days kept, agents counted and
// unchanged sessions served from the cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { CostReader, lastDays, localDate } from "../src/costs.ts";
import { piProvider, sessionCosts } from "../src/providers/pi.ts";
import { OpencodeServer, messageCosts, opencodeProvider, type OcMessage } from "../src/providers/opencode.ts";
import { startServer } from "../src/server.ts";

// Local times, so the buckets don't depend on the test machine's time zone.
const NOW = new Date(2026, 9, 17, 15, 0);
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 17 - daysAgo, hour, 30).getTime();

const piLine = (id: string, time: number, cost: number, role = "assistant") =>
  JSON.stringify({ type: "message", id, timestamp: new Date(time + 5).toISOString(), message: { role, timestamp: time, usage: { input: 10, output: 2, cost: { total: cost } } } });

function piSession(dir: string, name: string, lines: string[]): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, [JSON.stringify({ type: "session", id: name, timestamp: new Date(at(9, 1)).toISOString() }), ...lines].join("\n") + "\n");
  return file;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "casm-costs-"));
  const store = new Store(join(dir, "db"));
  const project = store.createProject({ name: "p", path: dir });
  const agent = (provider: "pi" | "opencode", session: string | null) => {
    const a = store.createAgent({ projectId: project.id, name: `${provider} ${session}`, provider, cwd: dir, config: {} });
    if (session) store.updateAgent(a.id, { nativeSessionId: session });
    return a;
  };
  return { dir, store, agent };
}

test("lastDays ends today, oldest first; localDate uses the local calendar", () => {
  assert.deepEqual(lastDays(3, NOW), ["2026-10-15", "2026-10-16", "2026-10-17"]);
  assert.equal(localDate(new Date(2026, 9, 16, 23, 59)), "2026-10-16");
  assert.equal(localDate(new Date(2026, 9, 17, 0, 1)), "2026-10-17");
  // Across a month end.
  assert.deepEqual(lastDays(2, new Date(2026, 10, 1, 9)), ["2026-10-31", "2026-11-01"]);
});

test("pi session costs: assistant, tool-reported and compaction calls; free ones left out", () => {
  const jsonl = [
    piLine("a", at(0, 9), 0.002),
    piLine("u", at(0, 9), 0.5, "user"),
    piLine("free", at(0, 10), 0),
    JSON.stringify({ type: "compaction", id: "c", timestamp: new Date(at(1, 8)).toISOString(), usage: { cost: { total: 0.001 } } }),
    JSON.stringify({ type: "message", id: "t", timestamp: new Date(at(2, 8)).toISOString(), message: { role: "toolResult", usage: { cost: { total: 0.0005 } } } }),
    "not json",
  ].join("\n");
  assert.deepEqual(sessionCosts(jsonl), [
    { at: at(0, 9), costUsd: 0.002 },
    { at: at(1, 8), costUsd: 0.001 },
    { at: at(2, 8), costUsd: 0.0005 },
  ]);
});

test("pi agents: per-day sums with zero days, several agents, past sessions, cache by file stamp", async () => {
  const { dir, store, agent } = setup();
  const one = piSession(dir, "one", [piLine("1", at(0, 9), 0.01), piLine("2", at(0, 23), 0.02), piLine("3", at(3, 12), 0.004)]);
  const two = piSession(dir, "two", [piLine("1", at(0, 1), 0.001), piLine("old", at(30, 12), 9)]);
  const past = piSession(dir, "past", [piLine("1", at(6, 12), 0.1)]);
  const a = agent("pi", one);
  store.addPastSession(a.id, past);
  agent("pi", two);
  agent("pi", null);
  agent("pi", join(dir, "missing.jsonl"));
  const reader = new CostReader(store, () => [piProvider()]);
  const first = await reader.costs(7, NOW);
  assert.equal(first.today, "2026-10-17");
  assert.equal(first.costs.length, 1);
  const pi = first.costs[0];
  assert.equal(pi.provider, "pi");
  assert.deepEqual(pi.days.map((d) => d.date), lastDays(7, NOW));
  assert.deepEqual(pi.days.map((d) => +d.costUsd.toFixed(6)), [0.1, 0, 0, 0.004, 0, 0, 0.031]);
  assert.equal(+pi.totalUsd.toFixed(6), 0.135);
  assert.equal(pi.agents, 2);
  assert.equal(pi.error, undefined);
  const reads = reader.reads;
  assert.equal(reads, 4);
  // Unchanged files come from the cache.
  assert.deepEqual(await reader.costs(7, NOW), first);
  assert.equal(reader.reads, reads);
  // A new message changes the file: only that session is read again.
  appendFileSync(two, piLine("new", at(1, 12), 0.05) + "\n");
  utimesSync(two, new Date(), new Date(Date.now() + 2000));
  const next = await reader.costs(7, NOW);
  assert.equal(reader.reads, reads + 1);
  assert.equal(+next.costs[0].days[5].costUsd.toFixed(6), 0.05);
  // A shorter window drops older days.
  assert.deepEqual((await reader.costs(1, NOW)).costs[0].days, [{ date: "2026-10-17", costUsd: next.costs[0].days[6].costUsd }]);
});

class FakeOpencode extends OpencodeServer {
  sessions = new Map<string, { updated: number; parent?: string; messages: OcMessage[] }>();
  requests: string[] = [];
  override async acquire() { return () => {}; }
  override async request<T>(_method: string, path: string): Promise<T> {
    this.requests.push(path);
    const m = /^\/session\/([^/]+)(\/message|\/children)?$/.exec(path);
    const s = m && this.sessions.get(m[1]);
    if (!m || !s) throw new Error(`no session for ${path}`);
    if (m[2] === "/message") return s.messages as T;
    if (m[2] === "/children") return [...this.sessions].filter(([, c]) => c.parent === m[1]).map(([id, c]) => ({ id, time: { updated: c.updated } })) as T;
    return { id: m[1], time: { updated: s.updated } } as T;
  }
}

const ocMessage = (id: string, session: string, cost: number, completed: number | undefined, role: "user" | "assistant" = "assistant"): OcMessage => ({
  info: { id, sessionID: session, role, cost, time: { created: completed ? completed - 1000 : at(0, 4), ...(completed ? { completed } : {}) } },
  parts: [],
});

test("OpenCode message costs: assistant messages by completion time", () => {
  assert.deepEqual(messageCosts([
    ocMessage("a", "s", 0.003, at(1, 10)).info,
    ocMessage("b", "s", 0.002, undefined).info,
    ocMessage("u", "s", 1, at(1, 10), "user").info,
    ocMessage("free", "s", 0, at(1, 10)).info,
  ]), [{ at: at(1, 10), costUsd: 0.003 }, { at: at(0, 4), costUsd: 0.002 }]);
});

test("OpenCode agents: subagent sessions count, the database stamp spares the server", async () => {
  const { dir, store, agent } = setup();
  const data = mkdtempSync(join(tmpdir(), "casm-costs-oc-"));
  writeFileSync(join(data, "opencode.db"), "x");
  const server = new FakeOpencode();
  server.sessions.set("ses_a", { updated: 1, messages: [ocMessage("1", "ses_a", 0.01, at(0, 9)), ocMessage("2", "ses_a", 0.02, at(2, 22))] });
  server.sessions.set("ses_child", { updated: 1, parent: "ses_a", messages: [ocMessage("c", "ses_child", 0.005, at(0, 10))] });
  server.sessions.set("ses_b", { updated: 1, messages: [ocMessage("1", "ses_b", 0.1, at(1, 9))] });
  server.sessions.set("ses_free", { updated: 1, messages: [ocMessage("1", "ses_free", 0, at(0, 9))] });
  agent("opencode", "ses_a");
  agent("opencode", "ses_b");
  agent("opencode", "ses_free");
  agent("opencode", "ses_gone");
  const providers = [opencodeProvider(server, data), piProvider()];
  const reader = new CostReader(store, () => providers);
  const first = await reader.costs(3, NOW);
  const oc = first.costs.find((c) => c.provider === "opencode")!;
  assert.deepEqual(oc.days.map((d) => +d.costUsd.toFixed(6)), [0.02, 0.1, 0.015]);
  assert.equal(+oc.totalUsd.toFixed(6), 0.135);
  assert.equal(oc.agents, 2);
  assert.match(oc.error ?? "", /^1 session unreadable/);
  // pi is installed with no agents: it reports zeros.
  assert.deepEqual(first.costs.find((c) => c.provider === "pi")!.days.map((d) => d.costUsd), [0, 0, 0]);
  // With the database untouched, nothing is asked of OpenCode for known sessions.
  server.requests = [];
  await reader.costs(3, NOW);
  assert.deepEqual(server.requests.filter((r) => !r.startsWith("/session/ses_gone")), []);
  // A write to the database: stamps are checked, and only the changed tree is read again.
  server.sessions.get("ses_child")!.updated = 2;
  server.sessions.get("ses_child")!.messages.push(ocMessage("d", "ses_child", 0.001, at(0, 11)));
  writeFileSync(join(data, "opencode.db-wal"), "y");
  server.requests = [];
  const next = await reader.costs(3, NOW);
  assert.equal(+next.costs.find((c) => c.provider === "opencode")!.days[2].costUsd.toFixed(6), 0.016);
  assert.ok(server.requests.includes("/session/ses_a/message"));
  assert.ok(!server.requests.includes("/session/ses_b/message"));
});

test("provider.costs over RPC", async () => {
  const { dir, store, agent } = setup();
  agent("pi", piSession(dir, "s", [piLine("1", Date.now() - 60_000, 0.25)]));
  const server = await startServer({ store, providers: [piProvider()], host: "127.0.0.1", port: 0, version: "test", home: dir, name: "costhost" });
  const client = await CasmClient.connect(`ws://127.0.0.1:${server.port}`, store.createToken("test"));
  try {
    const result = await client.call("provider.costs", {});
    assert.equal(result.costs[0].days.length, 7);
    assert.equal(result.costs[0].days.at(-1)!.date, result.today);
    assert.equal(result.costs[0].totalUsd, 0.25);
    assert.ok(result.timeZone);
  } finally {
    client.close();
    await server.close();
    store.close();
  }
});

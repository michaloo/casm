// End-to-end over a real WebSocket, with a scripted fake provider.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import type { AgentEvent, Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import type { OpenOptions, Provider, ProviderSession } from "../src/providers/types.ts";

// Replies "echo: <text>" after a tick. Text containing "ask" requests a
// permission first; "slow" waits until interrupted.
class FakeSession implements ProviderSession {
  opts: OpenOptions;
  closed = false;
  private abort = new AbortController();
  constructor(opts: OpenOptions) {
    this.opts = opts;
    setImmediate(() => opts.emit({ type: "sessionId", id: opts.resumeId ?? `native-${++fake.sessions}` }));
  }
  send(text: string) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 10));
      if (text.includes("slow")) {
        await new Promise((r) => this.abort.signal.addEventListener("abort", r, { once: true }));
        return this.opts.emit({ type: "turnEnded", outcome: "interrupted" });
      }
      if (text.includes("hit-limit") && !fake.limitHit) {
        fake.limitHit = true;
        this.opts.emit({ type: "item", item: { kind: "notice", id: `e-${text}`, text: "You've hit your usage limit. Try again in 2 hours.", level: "error" } });
        return this.opts.emit({ type: "turnEnded", outcome: "failed", error: "usage limit" });
      }
      if (text.includes("limits")) {
        this.opts.emit({ type: "limits", limits: { windows: [{ id: "five_hour", usedPercent: 80, status: "warning" }] } });
        this.opts.emit({ type: "item", item: { kind: "subagent", id: "sa1", title: "Explore repo", status: "done", summary: "found 3 files" } });
      }
      if (text.includes("question")) {
        const answers = await this.opts.askQuestion(
          { id: "q-1", prompts: [{ id: "color", text: "Pick a color", kind: "select", options: [{ label: "red" }, { label: "blue" }] }] },
          this.abort.signal,
        );
        this.opts.emit({ type: "item", item: { kind: "assistant", id: `a-${text}`, text: `answer: ${JSON.stringify(answers)}` } });
        return this.opts.emit({ type: "turnEnded", outcome: "completed" });
      }
      if (text.includes("ask")) {
        const a = await this.opts.askPermission(
          { id: "req-1", toolName: "Write", input: { file_path: "x" }, canAlwaysAllow: false },
          this.abort.signal,
        );
        if (a.decision === "deny") {
          this.opts.emit({ type: "item", item: { kind: "assistant", id: `a-${text}`, text: "denied" } });
          return this.opts.emit({ type: "turnEnded", outcome: "completed" });
        }
      }
      if (text.includes("tool")) {
        this.opts.emit({ type: "item", item: { kind: "tool", id: "t1", name: "Bash", input: {}, status: "running" } });
        this.opts.emit({ type: "toolOutput", itemId: "t1", text: "line 1\n" });
        this.opts.emit({ type: "usage", usage: { contextTokens: 500 } });
        this.opts.emit({ type: "usage", usage: { contextWindow: 1000 } });
        this.opts.emit({ type: "item", item: { kind: "tool", id: "t1", name: "Bash", input: {}, status: "done", output: "line 1\n" } });
      }
      this.opts.emit({ type: "delta", kind: "assistant", text: "ec" });
      this.opts.emit({ type: "item", item: { kind: "assistant", id: `a-${text}`, text: `echo: ${text}` } });
      this.opts.emit({ type: "turnEnded", outcome: "completed" });
    })();
  }
  shell(command: string, itemId: string) {
    if (command === "explode") throw new Error("boom");
    const item = { kind: "tool" as const, id: itemId, name: "shell", input: { command } };
    this.opts.emit({ type: "item", item: { ...item, status: "running" } });
    this.opts.emit({ type: "toolOutput", itemId, text: "out\n" });
    this.opts.emit({ type: "item", item: { ...item, status: "done", output: "out\n" } });
    this.opts.emit({ type: "turnEnded", outcome: "completed" });
  }
  async interrupt() {
    this.abort.abort();
  }
  async close() {
    this.closed = true;
    // A real process reports its exit asynchronously, after the manager moved on.
    setTimeout(() => this.opts.emit({ type: "closed" }), 20);
  }
}

const fake = {
  sessions: 0,
  opened: [] as OpenOptions[],
  history: new Map<string, Item[]>(),
  catalogCalls: 0,
  limitHit: false,
};

const provider: Provider = {
  id: "claude",
  open(opts) {
    fake.opened.push(opts);
    return new FakeSession(opts);
  },
  async history(sessionId) {
    return fake.history.get(sessionId) ?? [];
  },
  async usage(sessionId) {
    return sessionId === "native-usage" ? { contextTokens: 1000, contextWindow: 200000 } : null;
  },
  async commands() {
    return [{ name: "review", description: "Review changes", kind: "command" as const }];
  },
  async catalog() {
    fake.catalogCalls++;
    return { models: [{ id: "m1", isDefault: true, efforts: ["low", "high"] }], modes: [{ id: "default" }] };
  },
};

let server: RunningServer;
let client: CasmClient;
let store: Store;

before(async () => {
  store = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const token = store.createToken("test");
  server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  client = await CasmClient.connect(`ws://127.0.0.1:${server.port}`, token);
});

after(async () => {
  client.close();
  await server.close();
  store.close();
});

test("rejects bad tokens", async () => {
  await assert.rejects(CasmClient.connect(`ws://127.0.0.1:${server.port}`, "nope"), /unauthorized/);
});

test("health endpoint needs no auth", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal((await res.json()).protocol, 1);
});

test("projects are folders with an optional group", async () => {
  const p = await client.call("project.create", { path: "/tmp/work", group: "Clients", tags: ["client"] });
  assert.equal(p.name, "work");
  assert.equal(p.group, "Clients");
  await assert.rejects(client.call("project.create", { path: "relative/dir" }));
  const agent = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  assert.equal(agent.cwd, "/tmp/work");
  assert.equal((await client.call("project.update", { id: p.id, group: null })).group, null);
});

test("send, wait, history and session id are wired through", async () => {
  const p = await client.call("project.create", { name: "P1", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "hello" });
  const w = await client.call("agent.wait", { id: a.id });
  assert.deepEqual(w, { status: "idle", timedOut: false, lastReply: "echo: hello" });
  const stored = await client.call("agent.get", { id: a.id });
  assert.match(stored.nativeSessionId!, /^native-/);

  fake.history.set(stored.nativeSessionId!, [{ kind: "user", id: "u", text: "hello" }]);
  const h = await client.call("agent.history", { id: a.id });
  assert.equal(h.total, 1);
});

test("queues sends while busy and streams events to subscribers", async () => {
  const p = await client.call("project.create", { name: "P2", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const events: string[] = [];
  const off = client.on("agent.event", (n) => n.agentId === a.id && events.push(n.event.type));
  await client.call("agent.subscribe", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "one" });
  const second = await client.call("agent.send", { id: a.id, text: "two" });
  assert.equal(second.queued, true);
  await client.call("agent.wait", { id: a.id });
  // The queued turn starts as soon as the first ends.
  const w = await client.call("agent.wait", { id: a.id });
  assert.equal(w.lastReply, "echo: two");
  assert.equal(events.filter((e) => e === "turnEnded").length, 2);
  assert.ok(events.includes("delta"));
  off();
});

test("permission requests block the turn until answered", async () => {
  const p = await client.call("project.create", { name: "P3", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "please ask" });
  const w = await client.call("agent.wait", { id: a.id });
  assert.equal(w.status, "waiting");
  const sub = await client.call("agent.subscribe", { id: a.id });
  assert.equal(sub.permissions[0].id, "req-1");
  assert.ok(sub.turn.some((e) => e.type === "permission"));
  await client.call("agent.respondPermission", { id: a.id, requestId: "req-1", decision: "deny" });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "denied");
});

test("interrupt ends a running turn", async () => {
  const p = await client.call("project.create", { name: "P4", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await client.call("agent.get", { id: a.id })).status, "running");
  await client.call("agent.interrupt", { id: a.id });
  assert.equal((await client.call("agent.wait", { id: a.id })).status, "idle");
});

test("reload resumes the same session; late events from the old process are ignored", async () => {
  const p = await client.call("project.create", { name: "P5", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "first" });
  await client.call("agent.wait", { id: a.id });
  const native = (await client.call("agent.get", { id: a.id })).nativeSessionId;
  await client.call("agent.reload", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "slow" });
  // The old session's "closed" fires now; it must not end the new turn.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await client.call("agent.get", { id: a.id })).status, "running");
  assert.equal(fake.opened.at(-1)!.resumeId, native);
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });
});

test("restart clears the native session", async () => {
  const p = await client.call("project.create", { name: "P6", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "x" });
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.restart", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).nativeSessionId, null);
});

test("invalid params are rejected with JSON-RPC errors", async () => {
  await assert.rejects(
    client.call("agent.send", { id: "x", text: "hi", whenBusy: "later" as "queue" }),
    (e: CasmError) => e.code === -32602,
  );
  await assert.rejects(client.call("agent.get", { id: "missing" }), (e: CasmError) => e.code === 1001);
});

test("questions block the turn and return the answers", async () => {
  const p = await client.call("project.create", { name: "P7", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "a question" });
  assert.equal((await client.call("agent.wait", { id: a.id })).status, "waiting");
  const sub = await client.call("agent.subscribe", { id: a.id });
  assert.equal(sub.questions[0].prompts[0].id, "color");
  assert.deepEqual(sub.permissions, []);
  await assert.rejects(client.call("agent.respondPermission", { id: a.id, requestId: "q-1", decision: "allow" }));
  await client.call("agent.answerQuestion", { id: a.id, requestId: "q-1", answers: { color: "blue" } });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, 'answer: {"color":"blue"}');

  await client.call("agent.send", { id: a.id, text: "another question" });
  assert.equal((await client.call("agent.wait", { id: a.id })).status, "waiting");
  await client.call("agent.answerQuestion", { id: a.id, requestId: "q-1" });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "answer: null");
});

test("provider catalog is cached until refreshed", async () => {
  const before = fake.catalogCalls;
  const c = await client.call("provider.catalog", { provider: "claude" });
  assert.equal(c.models[0].id, "m1");
  await client.call("provider.catalog", { provider: "claude" });
  assert.equal(fake.catalogCalls, before + 1);
  await client.call("provider.catalog", { provider: "claude", refresh: true });
  assert.equal(fake.catalogCalls, before + 2);
  await assert.rejects(client.call("provider.catalog", { provider: "codex" }), (e: CasmError) => e.code === 1003);
});

test("config changes merge and reload the session, after the turn if one is running", async () => {
  const p = await client.call("project.create", { name: "P8", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", config: { model: "m1", mode: "default" }, prompt: "hi" });
  await client.call("agent.wait", { id: a.id });
  const opened = fake.opened.length;

  const u = await client.call("agent.update", { id: a.id, config: { mode: "", effort: "high" } });
  assert.deepEqual(u.config, { model: "m1", effort: "high" });
  await client.call("agent.send", { id: a.id, text: "again" });
  await client.call("agent.wait", { id: a.id });
  assert.equal(fake.opened.length, opened + 1, "idle agent reopens with the new config");
  assert.equal(fake.opened.at(-1)!.config.effort, "high");

  await client.call("agent.send", { id: a.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.update", { id: a.id, config: { model: "m2" } });
  assert.equal((await client.call("agent.get", { id: a.id })).status, "running", "running turn is not cut short");
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "after" });
  await client.call("agent.wait", { id: a.id });
  assert.equal(fake.opened.at(-1)!.config.model, "m2");
});

test("server identity, images, tool output, usage and commands", async () => {
  const info = await client.call("server.info", {});
  assert.match(info.id, /^[0-9a-f-]{36}$/);
  assert.equal((await client.call("server.info", {})).id, info.id);

  const p = await client.call("project.create", { name: "P9", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const events: AgentEvent[] = [];
  client.on("agent.event", (n) => n.agentId === a.id && events.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  await assert.rejects(client.call("agent.send", { id: a.id, text: " " }));
  await client.call("agent.send", { id: a.id, text: "use a tool", images: [{ mediaType: "image/png", data: "iVBOR" }] });
  await client.call("agent.wait", { id: a.id });
  const user = events.find((e) => e.type === "item" && e.item.kind === "user");
  assert.deepEqual(user?.type === "item" && user.item.kind === "user" && user.item.images, [{ mediaType: "image/png", data: "iVBOR" }]);
  assert.ok(events.some((e) => e.type === "toolOutput"));
  assert.deepEqual((await client.call("agent.usage", { id: a.id })).usage, { contextTokens: 500, contextWindow: 1000 });
  assert.equal((await client.call("agent.commands", { id: a.id })).commands[0].name, "review");
});

test("fs.search finds files under the agent's cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "casm-fs-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  const p = await client.call("project.create", { name: "P10", path: root });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const r = await client.call("fs.search", { agentId: a.id, query: "main" });
  assert.equal(r.root, root);
  assert.deepEqual(r.entries[0], { path: "src/main.ts", kind: "file" });
  const all = await client.call("fs.search", { cwd: root, query: "" });
  assert.ok(all.entries.some((e) => e.path === "src" && e.kind === "dir"));
  await assert.rejects(client.call("fs.search", { cwd: "relative", query: "x" }));
});

test("agent.shell runs as its own turn and is refused while busy", async () => {
  const p = await client.call("project.create", { name: "P11", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const events: AgentEvent[] = [];
  client.on("agent.event", (n) => n.agentId === a.id && events.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  await client.call("agent.shell", { id: a.id, command: "ls" });
  await client.call("agent.wait", { id: a.id });
  assert.deepEqual(
    events.map((e) => e.type),
    ["turnStarted", "item", "toolOutput", "item", "turnEnded"],
  );
  await client.call("agent.send", { id: a.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(client.call("agent.shell", { id: a.id, command: "ls" }), (e: CasmError) => e.code === 1002);
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });
});

test("a provider that throws while starting work leaves the agent idle", async () => {
  const p = await client.call("project.create", { name: "P12", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await assert.rejects(client.call("agent.shell", { id: a.id, command: "explode" }), /boom/);
  assert.equal((await client.call("agent.get", { id: a.id })).status, "idle");
});

test("modes must come from the agent's catalog", async () => {
  const p = await client.call("project.create", { name: "P13", path: "/tmp" });
  await assert.rejects(
    client.call("agent.create", { projectId: p.id, provider: "claude", config: { mode: "plan" } }),
    (e: CasmError) => e.code === -32602 && /unknown claude mode "plan"/.test(e.message),
  );
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", config: { mode: "default", model: "anything" } });
  await assert.rejects(client.call("agent.update", { id: a.id, config: { mode: "full-access" } }), (e: CasmError) => e.code === -32602);
});

test("limits reported by sessions are merged, cached and broadcast", async () => {
  const p = await client.call("project.create", { name: "P14", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const seen: number[] = [];
  const off = client.on("provider.limits", (n) => seen.push(n.limits.windows.length));
  await client.call("agent.send", { id: a.id, text: "check limits" });
  await client.call("agent.wait", { id: a.id });
  const { limits } = await client.call("provider.limits", {});
  assert.equal(limits[0].provider, "claude");
  assert.deepEqual(limits[0].windows, [{ id: "five_hour", usedPercent: 80, status: "warning" }]);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(await client.call("agent.subagentHistory", { id: a.id, subagentId: "sa1" }), { items: [] });
  off();
});

test("a turn that hits a usage limit is deferred, blocks further sends and retries later", async () => {
  const p = await client.call("project.create", { name: "P15", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const ended: AgentEvent[] = [];
  client.on("agent.event", (n) => n.agentId === a.id && n.event.type === "turnEnded" && ended.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "please hit-limit" });
  await client.call("agent.wait", { id: a.id });

  const turn = ended.at(-1);
  assert.ok(turn?.type === "turnEnded" && turn.limit?.resetsAt, "turnEnded carries the limit");
  const agent = await client.call("agent.get", { id: a.id });
  assert.ok(agent.deferred && Date.parse(agent.deferred.until) > Date.now() + 3600_000);
  const { limits } = await client.call("provider.limits", { provider: "claude" });
  assert.ok(limits[0].windows.some((w) => w.status === "exhausted"));

  // While limited: queue by default, or fail fast.
  const q = await client.call("agent.send", { id: a.id, text: "later" });
  assert.equal(q.queued, true);
  assert.equal(q.deferredUntil, agent.deferred!.until);
  await assert.rejects(client.call("agent.send", { id: a.id, text: "now", whenLimited: "fail" }), (e: CasmError) => e.code === 1004);
  // Another agent of the same provider waits too.
  const b = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  assert.equal((await client.call("agent.send", { id: b.id, text: "hello" })).queued, true);

  // After the reset the first deferred prompt runs; the rest follows.
  server.agents.runDueDeferred(Date.now() + 3 * 3600_000);
  assert.equal((await client.call("agent.get", { id: a.id })).deferred, null);
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "echo: later");
  assert.equal((await client.call("agent.get", { id: a.id })).deferred, null);

  // Interrupt drops a deferred prompt.
  await client.call("agent.interrupt", { id: b.id });
  assert.equal((await client.call("agent.get", { id: b.id })).deferred, null);
});

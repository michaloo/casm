// End-to-end over a real WebSocket, with a scripted fake provider.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import type { AgentEvent, ImageData, Item } from "@casm/protocol";
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
  send(text: string, _itemId: string, images?: ImageData[]) {
    fake.sent.push({ text, images });
    // The provider fails to start the turn at all.
    if (text.includes("throw-sync")) throw new Error("could not start the turn");
    void (async () => {
      await new Promise((r) => setTimeout(r, 10));
      // Reports its model late, after a config change made while it ran.
      if (text.includes("late-model")) await new Promise((r) => setTimeout(r, 50));
      // Claude reports its model as usage on system/init, before any answer.
      if (text.includes("init-usage")) this.opts.emit({ type: "usage", usage: { model: "claude-test" } });
      // The agent process crashes (e.g. a steer that arrives as it dies).
      if (text.includes("die")) return this.opts.emit({ type: "turnEnded", outcome: "failed", error: "agent process exited" });
      // Waits for the test to open fake.gate.
      if (text.includes("held")) await fake.gate.promise;
      // Starts answering, then hangs until interrupted.
      if (text.includes("partial")) this.opts.emit({ type: "delta", kind: "assistant", text: "Let me" });
      if (text.includes("slow")) {
        await new Promise((r) => this.abort.signal.addEventListener("abort", r, { once: true }));
        return this.opts.emit({ type: "turnEnded", outcome: "interrupted" });
      }
      if (text.includes("hit-limit") && !fake.limitHit) {
        fake.limitHit = true;
        this.opts.emit({ type: "item", item: { kind: "notice", id: `e-${text}`, text: "You've hit your usage limit. Try again in 2 hours.", level: "error" } });
        return this.opts.emit({ type: "turnEnded", outcome: "failed", error: "usage limit" });
      }
      // A session that can't be resumed fails before the agent answers anything.
      if (text.includes("no-session")) return this.opts.emit({ type: "turnEnded", outcome: "failed", error: "No conversation found with session ID: x" });
      if (text.includes("fails-late")) {
        this.opts.emit({ type: "item", item: { kind: "assistant", id: `a-${text}`, text: "working" } });
        return this.opts.emit({ type: "turnEnded", outcome: "failed", error: "API error" });
      }
      if (text.includes("unknown-usage")) this.opts.emit({ type: "limits", limits: { windows: [{ id: "seven_day", status: "ok" }] } });
      if (text.includes("limits")) {
        this.opts.emit({ type: "limits", limits: { windows: [{ id: "five_hour", usedPercent: 80, status: "warning" }] } });
        this.opts.emit({ type: "item", item: { kind: "subagent", id: "sa1", title: "Explore repo", status: "done", summary: "found 3 files" } });
      }
      // Launches a background subagent; it finishes later, outside any turn.
      if (text.includes("bg-agent")) this.opts.emit({ type: "item", item: { kind: "subagent", id: `bg-${text}`, title: "Background audit", agentType: "general-purpose", status: "running", activity: "Grep" } });
      if (text.includes("model")) this.opts.emit({ type: "model", model: this.opts.config.model ?? "provider-default" });
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
    const item = { kind: "tool" as const, id: itemId, name: "shell", origin: "user" as const, input: { command } };
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
  commandCalls: [] as string[],
  commandFailure: false,
  limitHit: false,
  limitsCalls: 0,
  gate: Promise.withResolvers<void>(),
  // What sessions were sent, images included.
  sent: [] as { text: string; images?: ImageData[] }[],
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
  async commands(cwd) {
    fake.commandCalls.push(cwd);
    await new Promise((r) => setTimeout(r, 20));
    if (fake.commandFailure) throw new Error("commands unavailable");
    return [{ name: "review", description: "Review changes", kind: "command" as const }];
  },
  async limits() {
    fake.limitsCalls++;
    return { windows: [{ id: "seven_day", usedPercent: 17 }] };
  },
  async catalog() {
    fake.catalogCalls++;
    return { models: [{ id: "m1", isDefault: true, efforts: ["low", "high"] }], modes: [{ id: "default" }] };
  },
};

let server: RunningServer;
let client: CasmClient;
let store: Store;
let home: string;
let token: string;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "casm-test-"));
  store = new Store(join(home, "casm.db"));
  token = store.createToken("test");
  server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", home, name: "testhost" });
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

test("browsers can pass the token in the URL", async () => {
  const { default: WebSocket } = await import("ws");
  const open = (url: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.once("open", () => (ws.close(), resolve(101)));
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    });
  assert.equal(await open(`ws://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}`), 101);
  assert.equal(await open(`ws://127.0.0.1:${server.port}/?token=nope`), 401);
});

test("serves the web client with a fallback to index.html", async () => {
  const web = mkdtempSync(join(tmpdir(), "casm-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html>app");
  writeFileSync(join(web, "assets", "a.js"), "x");
  const s = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const srv = await startServer({ store: s, providers: [], host: "127.0.0.1", port: 0, version: "test", webRoot: web });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    for (const path of ["/", "/agents/x"]) {
      const res = await fetch(base + path);
      assert.equal(await res.text(), "<!doctype html>app");
      assert.equal(res.headers.get("cache-control"), "no-cache");
    }
    const asset = await fetch(`${base}/assets/a.js`);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${base}/missing.js`)).status, 426);
    assert.equal(await (await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).text(), "<!doctype html>app");
    assert.equal((await (await fetch(`${base}/health`)).json()).protocol, 1);
  } finally {
    await srv.close();
    s.close();
  }
});

test("health endpoint needs no auth", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal((await res.json()).protocol, 1);
});

test("projects are folders with an optional group", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "casm-proj-")), "work");
  mkdirSync(dir);
  const p = await client.call("project.create", { path: dir, group: "Clients", tags: ["client"] });
  assert.equal(p.name, "work");
  assert.equal(p.group, "Clients");
  await assert.rejects(client.call("project.create", { path: "relative/dir" }));
  await assert.rejects(client.call("project.create", { path: join(dir, "missing") }), /no such directory/);
  const agent = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  assert.equal(agent.cwd, dir);
  assert.equal((await client.call("project.update", { id: p.id, group: null })).group, null);
});

test("an agent can work in a folder inside its project, never outside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "casm-cwd-"));
  const dir = join(root, "repo");
  mkdirSync(join(dir, ".worktrees", "task-1"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(dir, "escape"));
  symlinkSync(join(dir, ".worktrees"), join(dir, "wt"));
  const p = await client.call("project.create", { path: dir, name: "Worktrees" });
  const create = (cwd: string) => client.call("agent.create", { projectId: p.id, provider: "claude", cwd });

  assert.equal((await create(".worktrees/task-1")).cwd, join(dir, ".worktrees", "task-1"));
  assert.equal((await create(join(dir, ".worktrees", "task-1"))).cwd, join(dir, ".worktrees", "task-1"));
  assert.equal((await create(".")).cwd, dir);
  // A symlink that stays inside the project is fine.
  assert.equal((await create("wt/task-1")).cwd, join(dir, "wt", "task-1"));

  const invalid = async (cwd: string, message: RegExp) => {
    const e = await create(cwd).then(() => null, (e: CasmError) => e);
    assert.ok(e instanceof CasmError, `${cwd} was accepted`);
    assert.equal(e.code, -32602);
    assert.match(e.message, message);
  };
  await invalid("..", /must be inside the project folder/);
  await invalid("../elsewhere", /must be inside the project folder/);
  await invalid(join(root, "elsewhere"), /must be inside the project folder/);
  await invalid("escape", /must be inside the project folder .*resolves to .*elsewhere/);
  await invalid(".worktrees/missing", /no such directory on this host: .*missing/);
  writeFileSync(join(dir, "file.txt"), "");
  await invalid("file.txt", /no such directory/);
  rmSync(root, { recursive: true });
});

test("send, wait, history and session id are wired through", async () => {
  const p = await client.call("project.create", { name: "P1", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "hello" });
  const w = await client.call("agent.wait", { id: a.id });
  assert.deepEqual(w, { status: "idle", timedOut: false, lastReply: "echo: hello", lastTurn: { outcome: "completed" } });
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

test("wait after an interrupted turn has no reply rather than an older one", async () => {
  const p = await client.call("project.create", { name: "P4b", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "first" });
  await client.call("agent.wait", { id: a.id });
  const sid = (await client.call("agent.get", { id: a.id })).nativeSessionId!;
  fake.history.set(sid, [{ kind: "assistant", id: "old", text: "an older reply" }]);
  await client.call("agent.send", { id: a.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.interrupt", { id: a.id });
  const w = await client.call("agent.wait", { id: a.id });
  assert.deepEqual([w.lastReply, w.lastTurn], [null, { outcome: "interrupted" }]);
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
  const tools = events.flatMap((e) => e.type === "item" && e.item.kind === "tool" ? [e.item] : []);
  assert.equal(tools.length, 2);
  assert.ok(tools.every((item) => item.origin === "user"));
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

test("running subagents, background ones included, are counted from the live session and listed", async () => {
  const p = await client.call("project.create", { name: "Subagents", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  assert.deepEqual(a.subagents, { running: 0 });
  const counts: number[] = [];
  const off = client.on("agent.changed", (n) => n.agent.id === a.id && counts.push(n.agent.subagents!.running));
  await client.call("agent.send", { id: a.id, text: "bg-agent" });
  await client.call("agent.wait", { id: a.id });
  const session = fake.opened.at(-1)!;
  // The turn is over, the subagent still runs.
  let got = await client.call("agent.get", { id: a.id });
  assert.equal(got.status, "idle");
  assert.deepEqual(got.subagents, { running: 1 });
  // A client that connects now (an app reload) gets it from the server.
  const token = store.createToken("subagents-reload");
  const fresh = await CasmClient.connect(`ws://127.0.0.1:${server.port}`, token);
  const listed = (await fresh.call("agent.list", { projectId: p.id })).agents[0]!;
  assert.deepEqual(listed.subagents, { running: 1 });
  const all = (await fresh.call("agent.subagents", {})).subagents.filter((x) => x.agentId === a.id);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, "bg-bg-agent");
  assert.equal(all[0]!.activity, "Grep");
  assert.equal(all[0]!.status, "running");
  fresh.close();

  // Its completion arrives while the agent is idle.
  session.emit({ type: "item", item: { kind: "subagent", id: "bg-bg-agent", title: "Background audit", status: "done", summary: "no issues", usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 } } });
  await new Promise((r) => setTimeout(r, 20));
  got = await client.call("agent.get", { id: a.id });
  assert.deepEqual(got.subagents, { running: 0 });
  // Broadcast when the count changes (other changes, like the session id, carry it too).
  assert.deepEqual(counts.filter((n, i) => n !== counts[i - 1]), [0, 1, 0]);

  // One agent's list adds what its transcript records; a running one there
  // ran in a process that is gone.
  fake.history.set(got.nativeSessionId!, [
    { kind: "subagent", id: "old-1", title: "Earlier", status: "running" },
    { kind: "subagent", id: "old-2", title: "Done earlier", status: "running" },
    { kind: "subagent", id: "old-2", title: "Done earlier", status: "done", summary: "ok" },
  ]);
  const one = (await client.call("agent.subagents", { id: a.id })).subagents;
  assert.deepEqual(one.map((x) => [x.id, x.status, x.stale ?? false]), [["bg-bg-agent", "done", false], ["old-2", "done", false], ["old-1", "running", true]]);
  assert.deepEqual(one[0]!.usage, { totalTokens: 1200, toolUses: 4, durationMs: 9000 });
  assert.equal((await client.call("agent.subagents", { id: a.id, limit: 1 })).subagents.length, 1);

  // A session that ends takes its running subagents with it.
  await client.call("agent.send", { id: a.id, text: "bg-agent again" });
  await client.call("agent.wait", { id: a.id });
  assert.deepEqual((await client.call("agent.get", { id: a.id })).subagents, { running: 1 });
  await client.call("agent.reload", { id: a.id });
  assert.deepEqual((await client.call("agent.get", { id: a.id })).subagents, { running: 0 });
  const stale = (await client.call("agent.subagents", { id: a.id })).subagents.find((x) => x.id === "bg-bg-agent again")!;
  assert.equal(stale.stale, true);
  assert.equal(stale.status, "running");
  off();
});

test("the host agent prompt goes ahead of the agent's own system prompt, per agent, until disabled", async () => {
  const p = await client.call("project.create", { name: "Prompted", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", name: "helper", config: { systemPrompt: "Be brief.", casmTools: true }, prompt: "hi" });
  await client.call("agent.wait", { id: a.id });
  const sys = fake.opened.at(-1)!.config.systemPrompt!;
  assert.ok(sys.startsWith("You are running as an agent inside casm, an agent orchestrator, on host testhost."), sys);
  assert.match(sys, new RegExp(`agent "helper" \\(id ${a.id}, claude\\) in project Prompted, working in /tmp\\.`));
  assert.match(sys, /casm MCP tools .*list_hosts, .*answer_question\./);
  assert.ok(sys.endsWith("\n\nBe brief."));

  // Read and edited over the protocol; the next session gets it.
  const info = await client.call("server.agentPrompt", { agentId: a.id });
  assert.equal(info.rendered + "\n\nBe brief.", sys);
  assert.equal(info.custom, false);
  assert.equal(info.path, join(home, "agent-prompt.md"));
  const example = await client.call("server.agentPrompt", {});
  assert.match(example.rendered!, /agent "example"/);
  const saved = await client.call("server.setAgentPrompt", { content: "casm agent {{agentName}} ({{provider}})" });
  assert.equal(saved.custom, true);
  assert.equal(readFileSync(join(home, "agent-prompt.md"), "utf8"), "casm agent {{agentName}} ({{provider}})\n");
  await client.call("agent.reload", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "again" });
  await client.call("agent.wait", { id: a.id });
  assert.equal(fake.opened.at(-1)!.config.systemPrompt, "casm agent helper (claude)\n\nBe brief.");

  await client.call("server.setAgentPrompt", { enabled: false });
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).agentPrompt, false);
  await client.call("agent.reload", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "off" });
  await client.call("agent.wait", { id: a.id });
  assert.equal(fake.opened.at(-1)!.config.systemPrompt, "Be brief.");
  assert.equal((await client.call("server.agentPrompt", {})).rendered, null);

  const back = await client.call("server.setAgentPrompt", { enabled: true, content: null });
  assert.equal(back.custom, false);
  assert.equal(back.content, back.default);
});

test("the model a session reports is the agent's effectiveModel until config.model changes", async () => {
  const p = await client.call("project.create", { name: "P-model", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  assert.equal(a.effectiveModel, null);
  const changed: (string | null | undefined)[] = [];
  const off = client.on("agent.changed", (n) => n.agent.id === a.id && changed.push(n.agent.effectiveModel));
  await client.call("agent.send", { id: a.id, text: "which model" });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).effectiveModel, "provider-default");
  assert.ok(changed.includes("provider-default"), "agent.changed carries it");
  // Same model again: no change. Another config field keeps it.
  const unchanged = await client.call("agent.update", { id: a.id, config: { effort: "high" } });
  assert.equal(unchanged.effectiveModel, "provider-default");
  // A new model makes it stale until the next session reports.
  const updated = await client.call("agent.update", { id: a.id, config: { model: "sonnet" } });
  assert.equal(updated.effectiveModel, null);
  await client.call("agent.send", { id: a.id, text: "which model now" });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).effectiveModel, "sonnet");
  // The old session reporting its model after a mid-turn change doesn't make it current.
  await client.call("agent.send", { id: a.id, text: "late-model" });
  await client.call("agent.update", { id: a.id, config: { model: "opus" } });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).effectiveModel, null);
  await client.call("agent.send", { id: a.id, text: "which model, after the reload" });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).effectiveModel, "opus");
  off();
});

test("a window reported without usage asks the account once, and later reports keep the value", async () => {
  const p = await client.call("project.create", { name: "P-usage", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: a.id, text: "unknown-usage" });
  await client.call("agent.wait", { id: a.id });
  const before = fake.limitsCalls;
  const week = async () => (await client.call("provider.limits", {})).limits[0].windows.find((w) => w.id === "seven_day");
  assert.equal((await week())?.usedPercent, 17);
  assert.equal(fake.limitsCalls, before + 1);
  // Another live report without usage keeps 17, and doesn't query again.
  await client.call("agent.send", { id: a.id, text: "unknown-usage again" });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await week())?.usedPercent, 17);
  assert.equal(fake.limitsCalls, before + 1);
});

test("a turn that hits a usage limit is deferred, blocks further sends and retries later", async () => {
  const p = await client.call("project.create", { name: "P15", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const ended: AgentEvent[] = [];
  client.on("agent.event", (n) => n.agentId === a.id && n.event.type === "turnEnded" && ended.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "please hit-limit" });
  // Steered in before the limit hit, never answered: kept, not dropped.
  await client.call("agent.send", { id: a.id, text: "slow steer", whenBusy: "steer" });
  await client.call("agent.wait", { id: a.id });
  const kept = (await client.call("agent.pending", { id: a.id })).messages.map((m) => [m.reason, m.text]);
  assert.deepEqual(kept, [["limit", "please hit-limit"], ["failed", "slow steer"]]);

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
  server.agents.runDuePending(Date.now() + 3 * 3600_000);
  assert.equal((await client.call("agent.get", { id: a.id })).deferred, null);
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "echo: later");
  assert.equal((await client.call("agent.get", { id: a.id })).deferred, null);

  // Interrupt drops a deferred prompt.
  await client.call("agent.interrupt", { id: b.id });
  assert.equal((await client.call("agent.get", { id: b.id })).deferred, null);
});

test("a pending message is sent now or taken back with its images", async () => {
  const p = await client.call("project.create", { name: "P-steer-pending", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const image = { mediaType: "image/png", data: Buffer.from("png bytes").toString("base64") };
  await client.call("agent.send", { id: a.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  const q1 = await client.call("agent.send", { id: a.id, text: "look at this (slow)", images: [image] });
  const q2 = await client.call("agent.send", { id: a.id, text: "and this", images: [image, image] });
  // Listed with a count only.
  assert.deepEqual((await client.call("agent.pending", { id: a.id })).messages.map((m) => m.imageCount), [1, 2]);

  // Send now: steered into the running turn, image and all. ("slow" keeps
  // the fake's turn going, so the next message stays pending.)
  const events: AgentEvent[] = [];
  const off = client.on("agent.event", (n) => n.agentId === a.id && events.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  assert.deepEqual(await client.call("agent.steerPending", { id: a.id, messageId: q1.pendingId! }), { queued: false });
  assert.deepEqual(fake.sent.at(-1), { text: "look at this (slow)", images: [image] });
  await new Promise((r) => setTimeout(r, 20));
  const user = events.find((e) => e.type === "item" && e.item.kind === "user");
  assert.deepEqual(user?.type === "item" && user.item.kind === "user" && user.item.images, [image]);
  assert.equal(user?.type === "item" && user.item.id, q1.pendingId);
  await assert.rejects(client.call("agent.steerPending", { id: a.id, messageId: q1.pendingId! }), (e: CasmError) => e.code === 1001);

  // Take: removed, and the whole prompt comes back to edit.
  assert.deepEqual(await client.call("agent.takePending", { id: a.id, messageId: q2.pendingId! }), { text: "and this", images: [image, image] });
  assert.deepEqual((await client.call("agent.pending", { id: a.id })).messages, []);
  assert.deepEqual((await client.call("agent.get", { id: a.id })).pending, { count: 0 });
  await assert.rejects(client.call("agent.takePending", { id: a.id, messageId: q2.pendingId! }), (e: CasmError) => e.code === 1001);
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });

  // Idle: send now starts a turn with it.
  const kept = store.addPending({ agentId: a.id, text: "idle one", images: [image], reason: "queued", notBefore: null, note: null });
  assert.deepEqual(await client.call("agent.steerPending", { id: a.id, messageId: kept.id }), { queued: false });
  assert.deepEqual(fake.sent.at(-1), { text: "idle one", images: [image] });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "echo: idle one");
  assert.equal((await client.call("agent.takePending", { id: a.id, messageId: "nope" }).catch((e: CasmError) => e.code)), 1001);
  off();
});

test("pending messages are listed and cancellable", async () => {
  const p = await client.call("project.create", { name: "P16", path: "/tmp" });
  const b = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: b.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  const q1 = await client.call("agent.send", { id: b.id, text: "after slow" });
  const q2 = await client.call("agent.send", { id: b.id, text: "and then this" });
  const { messages } = await client.call("agent.pending", { id: b.id });
  assert.deepEqual(messages.map((m) => [m.reason, m.text]), [["queued", "after slow"], ["queued", "and then this"]]);
  assert.deepEqual((await client.call("agent.get", { id: b.id })).pending, { count: 2 });
  assert.ok((await client.call("pending.list", {})).messages.some((m) => m.id === q1.pendingId));
  assert.deepEqual(await client.call("agent.cancelPending", { id: b.id, messageId: q1.pendingId! }), { cancelled: 1 });
  await assert.rejects(client.call("agent.cancelPending", { id: b.id, messageId: q1.pendingId! }), (e: CasmError) => e.code === 1001);
  // Interrupt drops the rest.
  await client.call("agent.interrupt", { id: b.id });
  await client.call("agent.wait", { id: b.id });
  assert.deepEqual((await client.call("agent.pending", { id: b.id })).messages, []);
  assert.ok(q2.pendingId);
});

test("schedules message an agent or create one, and busy agents get pending messages", async () => {
  const p = await client.call("project.create", { name: "P17", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const every = await client.call("schedule.create", { cadence: { type: "every", minutes: 30 }, target: { type: "agent", agentId: a.id }, prompt: "status?" });
  assert.ok(Date.parse(every.nextRunAt!) > Date.now() + 29 * 60_000);
  await assert.rejects(client.call("schedule.create", { cadence: { type: "cron", expr: "nope" }, target: { type: "agent", agentId: a.id }, prompt: "x" }), (e: CasmError) => e.code === -32602);

  // Due: the agent gets the message.
  await server.scheduler.tick(new Date(Date.now() + 31 * 60_000));
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "echo: status?");
  const after = (await client.call("schedule.list", { agentId: a.id })).schedules[0];
  assert.equal(after.lastRun?.outcome, "sent");
  assert.ok(Date.parse(after.nextRunAt!) > Date.now() + 59 * 60_000);

  // Busy agent: queued as a pending message, or skipped when asked.
  await client.call("agent.send", { id: a.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await client.call("schedule.runNow", { id: every.id })).outcome, "queued");
  const skip = await client.call("schedule.create", { cadence: { type: "every", minutes: 5 }, target: { type: "agent", agentId: a.id, whenBusy: "skip" }, prompt: "ping" });
  assert.equal((await client.call("schedule.runNow", { id: skip.id })).outcome, "skipped");
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });
  // A kept failed message doesn't make an idle agent busy.
  await client.call("agent.send", { id: a.id, text: "no-session" });
  await client.call("agent.wait", { id: a.id });
  assert.equal((await client.call("agent.pending", { id: a.id })).messages[0].reason, "failed");
  assert.equal((await client.call("schedule.runNow", { id: skip.id })).outcome, "sent");
  await client.call("agent.wait", { id: a.id });

  // A once schedule creating a new agent from a preset disables itself after running.
  const at = new Date(Date.now() + 3600_000).toISOString();
  const once = await client.call("schedule.create", {
    name: "nightly",
    cadence: { type: "once", at },
    target: { type: "newAgent", projectId: p.id, provider: "claude", config: { mode: "default" } },
    prompt: "do the nightly",
  });
  await server.scheduler.tick(new Date(Date.now() + 2 * 3600_000));
  const ran = (await client.call("schedule.list", {})).schedules.find((x) => x.id === once.id)!;
  assert.equal(ran.lastRun?.outcome, "created");
  assert.equal(ran.enabled, false);
  assert.equal(ran.nextRunAt, null);
  const created = await client.call("agent.get", { id: ran.lastRun!.agentId! });
  assert.match(created.name, /^nightly · /);
  assert.equal((await client.call("agent.wait", { id: created.id })).lastReply, "echo: do the nightly");

  // Deleting the agent removes its schedules.
  await client.call("agent.delete", { id: a.id });
  assert.deepEqual((await client.call("schedule.list", { agentId: a.id })).schedules, []);
});


test("commands share cache by provider and cwd, warm on open, refresh, expire and retry failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-commands-"));
  const p = await client.call("project.create", { path: root });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const b = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const calls = () => fake.commandCalls.filter((cwd) => cwd === root).length;
  await client.call("agent.send", { id: a.id, text: "hello" });
  assert.equal(calls(), 1); // Opening the session starts warming before any lookup.
  await Promise.all([client.call("agent.commands", { id: a.id }), client.call("agent.commands", { id: b.id })]);
  assert.equal(calls(), 1);
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.commands", { id: b.id });
  assert.equal(calls(), 1);
  await Promise.all([a, b].map((agent) => client.call("agent.commands", { id: agent.id, refresh: true })));
  assert.equal(calls(), 2);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 5 * 60_000 + 1);
  await client.call("agent.commands", { id: a.id });
  assert.equal(calls(), 3);
  t.mock.restoreAll();
  fake.commandFailure = true;
  try {
    await assert.rejects(client.call("agent.commands", { id: a.id, refresh: true }), /commands unavailable/);
  } finally {
    fake.commandFailure = false;
  }
  await client.call("agent.commands", { id: b.id });
  assert.equal(calls(), 5);
  const otherProject = await client.call("project.create", { path: "/tmp" });
  const other = await client.call("agent.create", { projectId: otherProject.id, provider: "claude" });
  await client.call("agent.commands", { id: other.id, refresh: true });
  assert.equal(calls(), 5);
});

test("AGENTS.md versioned writes reject stale and concurrent saves and remain atomic", async () => {
  const root = mkdtempSync(join(tmpdir(), "casm-agents-md-"));
  const p = await client.call("project.create", { path: root });
  const path = join(root, "AGENTS.md");
  const read = () => client.call("project.agentsMd", { id: p.id });
  const save = (content: string, expectedSha256?: string | null) =>
    client.call("project.setAgentsMd", { id: p.id, content, expectedSha256 });
  const conflict = (e: CasmError) => e.code === 1003 && /changed/.test(e.message);
  assert.equal((await read()).sha256, null);
  await save("first", null);
  const first = (await read()).sha256!;
  assert.equal(first, createHash("sha256").update("first").digest("hex"));
  await assert.rejects(save("wrong", null), conflict);
  writeFileSync(path, "external edit");
  await assert.rejects(save("wrong", first), conflict);
  assert.equal(readFileSync(path, "utf8"), "external edit");
  const current = (await read()).sha256!;
  const results = await Promise.allSettled([save("winner A", current), save("winner B", current)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected?.status === "rejected" && conflict(rejected.reason));
  assert.match(readFileSync(path, "utf8"), /^winner [AB]$/);
  assert.deepEqual(readdirSync(root), ["AGENTS.md"]);
  await save(""); // Legacy unconditional saves still work.
  assert.equal((await read()).sha256, createHash("sha256").update("").digest("hex"));
  unlinkSync(path);
  await assert.rejects(save("wrong", first), conflict);
  await save("recreated", null);
});

test("an agent whose folder disappeared fails loudly instead of dropping the message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-gone-"));
  const p = await client.call("project.create", { path: dir });
  const agent = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  rmSync(dir, { recursive: true });
  await assert.rejects(client.call("agent.send", { id: agent.id, text: "hi" }), /folder does not exist/);
});

test("a queued message for an agent whose folder disappeared is kept as failed, not deferred as a limit", async () => {
  const s2 = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const project = s2.createProject({ name: "P", path: "/tmp" });
  const agent = s2.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: join(tmpdir(), "casm-gone-for-good"), config: {} });
  s2.addPending({ agentId: agent.id, text: "left over", reason: "queued", notBefore: null, note: null });
  const srv = await startServer({ store: s2, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  try {
    const [m] = s2.listPending(agent.id);
    assert.deepEqual([m.reason, m.text], ["failed", "left over"]);
    assert.match(m.note ?? "", /folder does not exist/);
  } finally {
    await srv.close();
    s2.close();
  }
});

test("a prompt whose turn failed before any answer is kept as a failed pending message", async () => {
  const p = await client.call("project.create", { name: "P-failed", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: a.id, text: "no-session please" });
  const w = await client.call("agent.wait", { id: a.id });
  const [m] = (await client.call("agent.pending", { id: a.id })).messages;
  // lastTurn names what it kept, so "casm wait" points at this message and not an older one.
  assert.deepEqual(w.lastTurn, { outcome: "failed", error: "No conversation found with session ID: x", kept: [m.id] });
  assert.deepEqual([m.reason, m.text, m.note], ["failed", "no-session please", "No conversation found with session ID: x"]);
  assert.deepEqual((await client.call("agent.get", { id: a.id })).pending, { count: 1 });
  // Usage reported at startup (Claude's init) isn't an answer.
  const u = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: u.id, text: "init-usage, then no-session" });
  await client.call("agent.wait", { id: u.id });
  assert.deepEqual((await client.call("agent.pending", { id: u.id })).messages.map((x) => [x.reason, x.text]), [["failed", "init-usage, then no-session"]]);
  // Never resent on its own, and it doesn't hold back later messages.
  server.agents.runDuePending(Date.now() + 86_400_000);
  assert.equal((await client.call("agent.get", { id: a.id })).status, "idle");
  await client.call("agent.send", { id: a.id, text: "hello" });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastReply, "echo: hello");
  assert.equal((await client.call("agent.pending", { id: a.id })).messages.length, 1);
  // A turn that failed after the agent answered has the prompt in its history already.
  await client.call("agent.send", { id: a.id, text: "fails-late" });
  assert.deepEqual((await client.call("agent.wait", { id: a.id })).lastTurn, { outcome: "failed", error: "API error" });
  assert.equal((await client.call("agent.pending", { id: a.id })).messages.length, 1);
  // Retry sends it again (and fails again here, keeping it once more).
  const queued = await client.call("agent.send", { id: a.id, text: "slow" });
  await assert.rejects(client.call("agent.retryPending", { id: a.id, messageId: queued.pendingId ?? "x" }), (e: CasmError) => e.code === 1001);
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.interrupt", { id: a.id });
  await client.call("agent.wait", { id: a.id });
  // interrupt dropped the pending messages, including the failed one; make a new one.
  await client.call("agent.send", { id: a.id, text: "no-session again" });
  await client.call("agent.wait", { id: a.id });
  const failed = (await client.call("agent.pending", { id: a.id })).messages[0];
  assert.deepEqual(await client.call("agent.retryPending", { id: a.id, messageId: failed.id }), { queued: false });
  await client.call("agent.wait", { id: a.id });
  const again = (await client.call("agent.pending", { id: a.id })).messages;
  assert.deepEqual(again.map((x) => [x.reason, x.text]), [["failed", "no-session again"]]);
  assert.notEqual(again[0].id, failed.id);
  // Only failed messages can be retried (a fresh agent: the fake can be interrupted once per session).
  const b = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: b.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  const q = await client.call("agent.send", { id: b.id, text: "queued one" });
  await assert.rejects(client.call("agent.retryPending", { id: b.id, messageId: q.pendingId! }), (e: CasmError) => e.code === -32602);
  await client.call("agent.interrupt", { id: b.id });
  await client.call("agent.wait", { id: b.id });
});

test("a retry whose send throws keeps the message once", async () => {
  const p = await client.call("project.create", { name: "P-retry-throws", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await assert.rejects(client.call("agent.send", { id: a.id, text: "throw-sync" }), /could not start the turn/);
  const [m] = (await client.call("agent.pending", { id: a.id })).messages;
  assert.deepEqual([m.reason, m.text], ["failed", "throw-sync"]);
  await assert.rejects(client.call("agent.retryPending", { id: a.id, messageId: m.id }), /could not start the turn/);
  assert.deepEqual((await client.call("agent.pending", { id: a.id })).messages.map((x) => [x.reason, x.text]), [["failed", "throw-sync"]]);
});

test("prompts steered into a turn that fails are kept when nothing came back after them", async () => {
  const p = await client.call("project.create", { name: "P-steer-failed", path: "/tmp" });
  const pending = async (id: string) => (await client.call("agent.pending", { id })).messages.map((m) => [m.reason, m.text, m.note]);
  // Started answering, then a steer the agent never got to: only the steer is kept.
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: a.id, text: "partial, then slow" });
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.send", { id: a.id, text: "steer: die", whenBusy: "steer" });
  assert.equal((await client.call("agent.wait", { id: a.id })).lastTurn?.outcome, "failed");
  assert.deepEqual(await pending(a.id), [["failed", "steer: die", "agent process exited"]]);
  // Nothing came back at all: the first prompt and the steer, in order.
  const b = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: b.id, text: "slow start" });
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.send", { id: b.id, text: "then die", whenBusy: "steer" });
  await client.call("agent.wait", { id: b.id });
  assert.deepEqual(await pending(b.id), [["failed", "slow start", "agent process exited"], ["failed", "then die", "agent process exited"]]);
  // Interrupted turns keep nothing: the user stopped them.
  const c = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  await client.call("agent.send", { id: c.id, text: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  await client.call("agent.send", { id: c.id, text: "slow steer", whenBusy: "steer" });
  await client.call("agent.interrupt", { id: c.id });
  await client.call("agent.wait", { id: c.id });
  assert.deepEqual(await pending(c.id), []);
});

test("messages queued and schedule runs missed while the server was down go out as soon as it starts", async () => {
  const s2 = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const token = s2.createToken("t");
  const project = s2.createProject({ name: "P", path: "/tmp" });
  const agent = s2.createAgent({ projectId: project.id, name: "a", provider: "claude", cwd: "/tmp", config: {} });
  s2.addPending({ agentId: agent.id, text: "left over, held", reason: "queued", notBefore: null, note: null });
  const missed = new Date(Date.now() - 60_000).toISOString();
  s2.saveSchedule({ id: "missed", name: "m", enabled: true, cadence: { type: "once", at: missed }, target: { type: "agent", agentId: agent.id }, prompt: "missed run", nextRunAt: missed, lastRun: null, createdAt: missed });
  const srv = await startServer({ store: s2, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const c = await CasmClient.connect(`ws://127.0.0.1:${srv.port}`, token);
  try {
    // The left-over message is running; the missed run queued behind it.
    assert.deepEqual((await c.call("agent.pending", { id: agent.id })).messages.map((m) => m.text), ["missed run"]);
    assert.equal((await c.call("schedule.list", {})).schedules[0].lastRun?.outcome, "queued");
    fake.gate.resolve();
    for (let i = 0; i < 50 && (await c.call("agent.wait", { id: agent.id })).lastReply !== "echo: missed run"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await c.call("agent.wait", { id: agent.id })).lastReply, "echo: missed run");
  } finally {
    c.close();
    await srv.close();
    s2.close();
  }
});

test("a prompt the agent hasn't answered when the server stops is kept as a failed pending message", async () => {
  const s2 = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const project = s2.createProject({ name: "P", path: "/tmp" });
  const answered = s2.createAgent({ projectId: project.id, name: "answered", provider: "claude", cwd: "/tmp", config: {} });
  const silent = s2.createAgent({ projectId: project.id, name: "silent", provider: "claude", cwd: "/tmp", config: {} });
  const srv = await startServer({ store: s2, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  srv.agents.send(silent.id, { text: "slow, never answered" });
  await new Promise((r) => setTimeout(r, 30));
  srv.agents.send(silent.id, { text: "slow steer, never answered" }, "steer");
  srv.agents.send(answered.id, { text: "partial, then slow" });
  await new Promise((r) => setTimeout(r, 30));
  await srv.close();
  // The agent that had started answering has the prompt in its own history.
  assert.deepEqual(s2.listPending(answered.id), []);
  const [m, steer] = s2.listPending(silent.id);
  assert.deepEqual([m.reason, m.text, m.note], ["failed", "slow, never answered", "the server stopped before the agent answered"]);
  assert.deepEqual([steer.reason, steer.text], ["failed", "slow steer, never answered"]);
  // The agent's process may finish the turn after the server is gone: then the
  // next start sees the answer in its history and drops the kept message.
  const sid = s2.getAgent(silent.id)!.nativeSessionId!;
  fake.history.set(sid, [
    { kind: "user", id: "u", text: "slow, never answered" },
    { kind: "user", id: "u2", text: "slow steer, never answered" },
    { kind: "assistant", id: "a", text: "done after all" },
  ]);
  const other = s2.addPending({ agentId: answered.id, text: "not answered", reason: "failed", notBefore: null, note: "x" });
  const again = await startServer({ store: s2, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  for (let i = 0; i < 50 && s2.listPending(silent.id).length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s2.listPending(silent.id), []);
  assert.deepEqual(s2.listPending(answered.id).map((x) => x.id), [other.id]);
  await again.close();
  s2.close();
});

test("a queued message lands as a user item with its pending id", async () => {
  fake.gate = Promise.withResolvers<void>();
  const p = await client.call("project.create", { name: "P-pending-id", path: "/tmp" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude" });
  const events: AgentEvent[] = [];
  const off = client.on("agent.event", (n) => n.agentId === a.id && events.push(n.event));
  await client.call("agent.subscribe", { id: a.id });
  await client.call("agent.send", { id: a.id, text: "held first" });
  const q = await client.call("agent.send", { id: a.id, text: "second" });
  assert.equal(q.queued, true);
  fake.gate.resolve();
  for (let i = 0; i < 100 && !events.some((e) => e.type === "item" && e.item.kind === "user" && e.item.text === "second"); i++)
    await new Promise((r) => setTimeout(r, 10));
  const users = events.filter((e) => e.type === "item" && e.item.kind === "user" && e.item.text === "second");
  // Once, and with the id clients showed while it was pending.
  assert.equal(users.length, 1);
  assert.equal(users[0].type === "item" && users[0].item.id, q.pendingId);
  await client.call("agent.wait", { id: a.id });
  off();
});

// End-to-end over a real WebSocket, with a scripted fake provider.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import type { Item } from "@casm/protocol";
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
      this.opts.emit({ type: "delta", kind: "assistant", text: "ec" });
      this.opts.emit({ type: "item", item: { kind: "assistant", id: `a-${text}`, text: `echo: ${text}` } });
      this.opts.emit({ type: "turnEnded", outcome: "completed" });
    })();
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

test("projects nest, inherit paths and refuse cycles", async () => {
  const parent = await client.call("project.create", { name: "Work", path: "/tmp/work" });
  const child = await client.call("project.create", { name: "Client A", parentId: parent.id, tags: ["client"] });
  assert.equal(store.projectPath(child.id), "/tmp/work");
  await assert.rejects(client.call("project.update", { id: parent.id, parentId: child.id }), (e: CasmError) => e.code === 1003);
  const agent = await client.call("agent.create", { projectId: child.id, provider: "claude" });
  assert.equal(agent.cwd, "/tmp/work");
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
  const p = await client.call("project.create", { name: "P2" });
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
  const p = await client.call("project.create", { name: "P3" });
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
  const p = await client.call("project.create", { name: "P4" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "slow" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await client.call("agent.get", { id: a.id })).status, "running");
  await client.call("agent.interrupt", { id: a.id });
  assert.equal((await client.call("agent.wait", { id: a.id })).status, "idle");
});

test("reload resumes the same session; late events from the old process are ignored", async () => {
  const p = await client.call("project.create", { name: "P5" });
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
  const p = await client.call("project.create", { name: "P6" });
  const a = await client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "x" });
  await client.call("agent.wait", { id: a.id });
  await client.call("agent.restart", { id: a.id });
  assert.equal((await client.call("agent.get", { id: a.id })).nativeSessionId, null);
});

test("invalid params are rejected with JSON-RPC errors", async () => {
  await assert.rejects(
    client.call("agent.send", { id: "x", text: "" }),
    (e: CasmError) => e.code === -32602,
  );
  await assert.rejects(client.call("agent.get", { id: "missing" }), (e: CasmError) => e.code === 1001);
});

// Message path races: resent sends, failed starts, queue order and in-place edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

// A provider whose turns end only when the test says so.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "casm-queue-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const sent: { text: string; id: string }[] = [];
  const sessions: OpenOptions[] = [];
  const state = { throwOn: new Set<string>() };
  const provider: Provider = {
    id: "codex",
    open(opts) {
      sessions.push(opts);
      return {
        send(text, id) {
          if (state.throwOn.has(text)) throw new Error(`cannot take ${text}`);
          sent.push({ text, id });
        },
        shell() {},
        async interrupt() { opts.emit({ type: "turnEnded", outcome: "interrupted" }); },
        async close() {},
      };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  };
  const finish = () => sessions.at(-1)!.emit({ type: "turnEnded", outcome: "completed" });
  const fail = (error: string) => sessions.at(-1)!.emit({ type: "turnEnded", outcome: "failed", error });
  return { dir, store, token, sent, state, provider, finish, fail };
}

async function run(fn: (t: ReturnType<typeof setup> & { client: CasmClient; agent: string }) => Promise<void>) {
  const t = setup();
  const server = await startServer({ store: t.store, providers: [t.provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, t.token);
  try {
    const project = await client.call("project.create", { path: t.dir });
    const agent = await client.call("agent.create", { projectId: project.id, provider: "codex" });
    await fn({ ...t, client, agent: agent.id });
  } finally {
    client.close();
    await server.close();
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
}

test("a resent messageId is delivered once and keeps its id as the user item id", async () => {
  await run(async ({ client, agent, sent, finish }) => {
    const first = randomUUID();
    assert.deepEqual(await client.call("agent.send", { id: agent, text: "hello", messageId: first }), { queued: false });
    assert.deepEqual(await client.call("agent.send", { id: agent, text: "hello", messageId: first }), { queued: false });
    assert.deepEqual(sent, [{ text: "hello", id: first }]);
    const turn = (await client.call("agent.subscribe", { id: agent })).turn;
    assert.ok(turn.some((e) => e.type === "item" && e.item.kind === "user" && e.item.id === first));

    // Busy: the same id again finds the pending message instead of adding one.
    const queued = randomUUID();
    const r1 = await client.call("agent.send", { id: agent, text: "later", messageId: queued });
    const r2 = await client.call("agent.send", { id: agent, text: "later", messageId: queued });
    assert.deepEqual(r1, { queued: true, pendingId: queued });
    assert.deepEqual(r2, r1);
    assert.equal((await client.call("agent.pending", { id: agent })).messages.length, 1);
    finish();
    await client.call("agent.wait", { id: agent, timeoutMs: 1 });
    assert.deepEqual(sent.map((s) => s.id), [first, queued]);
    // Delivered from the queue: still not sent twice.
    assert.deepEqual(await client.call("agent.send", { id: agent, text: "later", messageId: queued }), { queued: false });
    assert.equal(sent.length, 2);
  });
});

test("a messageId of another agent's pending message is refused", async () => {
  await run(async ({ client, agent, dir }) => {
    const project = (await client.call("project.list", {})).projects[0];
    const other = await client.call("agent.create", { projectId: project.id, provider: "codex" });
    await client.call("agent.send", { id: other.id, text: "busy" });
    const id = randomUUID();
    await client.call("agent.send", { id: other.id, text: "queued", messageId: id });
    await client.call("agent.send", { id: agent, text: "busy" });
    await assert.rejects(client.call("agent.send", { id: agent, text: "x", messageId: id }), /already used/);
    assert.ok(dir);
  });
});

test("a provider that throws on a queued prompt keeps it as failed exactly once", async () => {
  await run(async ({ client, agent, state, finish }) => {
    await client.call("agent.send", { id: agent, text: "first" });
    await client.call("agent.send", { id: agent, text: "breaks" });
    state.throwOn.add("breaks");
    finish();
    const pending = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual(pending.map((m) => [m.text, m.reason]), [["breaks", "failed"]]);
    assert.equal((await client.call("agent.get", { id: agent })).status, "idle");
  });
});

test("Send now and Retry of a prompt the provider rejects keep one failed copy", async () => {
  await run(async ({ client, agent, state }) => {
    await client.call("agent.send", { id: agent, text: "first" });
    const r = await client.call("agent.send", { id: agent, text: "breaks" });
    state.throwOn.add("breaks");
    await assert.rejects(client.call("agent.steerPending", { id: agent, messageId: r.pendingId! }), /cannot take/);
    const failed = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual(failed.map((m) => [m.text, m.reason]), [["first", "failed"], ["breaks", "failed"]]);
    // Retrying while it still fails must not multiply it either.
    await assert.rejects(client.call("agent.retryPending", { id: agent, messageId: failed[1].id }), /cannot take/);
    const after = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual(after.map((m) => [m.text, m.reason]), [["first", "failed"], ["breaks", "failed"]]);
  });
});

test("Send now that is refused before dispatch keeps the message where it was, same id", async () => {
  await run(async ({ client, agent, dir, store }) => {
    // Waiting messages from before a restart, on an agent whose folder is now gone.
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const project = (await client.call("project.list", {})).projects[0];
    const moved = await client.call("agent.create", { projectId: project.id, provider: "codex", cwd: sub });
    const a = store.addPending({ agentId: moved.id, text: "a", reason: "failed", notBefore: null, note: "x" });
    const b = store.addPending({ agentId: moved.id, text: "b", reason: "failed", notBefore: null, note: "x" });
    rmSync(sub, { recursive: true });
    await assert.rejects(client.call("agent.steerPending", { id: moved.id, messageId: b.id }), /does not exist/);
    const ids = (await client.call("agent.pending", { id: moved.id })).messages.map((m) => m.id);
    assert.deepEqual(new Set(ids), new Set([a.id, b.id]));
    assert.equal(ids.length, 2);
    assert.ok(agent);
  });
});

test("an idle agent with waiting messages sends a new one after them", async () => {
  await run(async ({ client, agent, store, sent, finish }) => {
    // Left over from before a restart, not yet picked up by the timer.
    store.addPending({ agentId: agent, text: "older", reason: "queued", notBefore: null, note: null });
    const r = await client.call("agent.send", { id: agent, text: "newer" });
    assert.equal(r.queued, true);
    assert.deepEqual(sent.map((s) => s.text), ["older"]);
    finish();
    assert.deepEqual(sent.map((s) => s.text), ["older", "newer"]);
  });
});

test("a pending message can be edited in place until it is sent", async () => {
  await run(async ({ client, agent, finish }) => {
    await client.call("agent.send", { id: agent, text: "busy" });
    const a = await client.call("agent.send", { id: agent, text: "a" });
    const b = await client.call("agent.send", { id: agent, text: "b" });
    await client.call("agent.editPending", { id: agent, messageId: a.pendingId!, text: "a, edited" });
    const pending = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual(pending.map((m) => [m.id, m.text]), [[a.pendingId, "a, edited"], [b.pendingId, "b"]]);
    await assert.rejects(client.call("agent.editPending", { id: agent, messageId: a.pendingId!, text: " " }), /nothing to send/);
    finish();
    await assert.rejects(client.call("agent.editPending", { id: agent, messageId: a.pendingId!, text: "too late" }), /no such pending/);
  });
});

test("interrupt stops the turn and the queue goes on in order", async () => {
  await run(async ({ client, agent, sent, finish }) => {
    await client.call("agent.send", { id: agent, text: "long task" });
    await client.call("agent.send", { id: agent, text: "next 1" });
    await client.call("agent.send", { id: agent, text: "next 2" });
    await client.call("agent.interrupt", { id: agent });
    assert.deepEqual(sent.map((s) => s.text), ["long task", "next 1"]);
    assert.deepEqual((await client.call("agent.pending", { id: agent })).messages.map((m) => m.text), ["next 2"]);
    finish();
    assert.deepEqual(sent.map((s) => s.text), ["long task", "next 1", "next 2"]);
  });
});

test("a prompt kept after a failed turn holds the queue until Retry now or Cancel", async () => {
  await run(async ({ client, agent, sent, finish, fail }) => {
    await client.call("agent.send", { id: agent, text: "unlucky" });
    await client.call("agent.send", { id: agent, text: "behind 1" });
    fail("No conversation found");
    // Kept ahead of the queue, and nothing behind it overtakes it.
    const pending = async () => (await client.call("agent.pending", { id: agent })).messages.map((m) => [m.reason, m.text]);
    assert.deepEqual(await pending(), [["failed", "unlucky"], ["queued", "behind 1"]]);
    assert.equal((await client.call("agent.send", { id: agent, text: "behind 2" })).queued, true);
    assert.deepEqual(sent.map((s) => s.text), ["unlucky"]);
    // Retry now sends it again; the rest follows it.
    const [held] = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual(await client.call("agent.retryPending", { id: agent, messageId: held.id }), { queued: false });
    finish();
    assert.deepEqual(sent.map((s) => s.text), ["unlucky", "unlucky", "behind 1"]);
    // Failing again holds it again; cancelling it lets the queue go on.
    fail("still broken");
    const [again] = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual([again.reason, again.text], ["failed", "behind 1"]);
    await client.call("agent.cancelPending", { id: agent, messageId: again.id });
    assert.deepEqual(sent.map((s) => s.text), ["unlucky", "unlucky", "behind 1", "behind 2"]);
  });
});

test("Retry now on a later message keeps its place when it fails again", async () => {
  await run(async ({ client, agent, state, fail }) => {
    await client.call("agent.send", { id: agent, text: "a" });
    await client.call("agent.send", { id: agent, text: "b", whenBusy: "steer" });
    fail("process exited");
    const [a, b] = (await client.call("agent.pending", { id: agent })).messages;
    assert.deepEqual([a.text, b.text], ["a", "b"]);
    state.throwOn.add("b");
    await assert.rejects(client.call("agent.retryPending", { id: agent, messageId: b.id }), /cannot take/);
    assert.deepEqual((await client.call("agent.pending", { id: agent })).messages.map((m) => [m.reason, m.text]), [["failed", "a"], ["failed", "b"]]);
  });
});

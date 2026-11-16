// Idle unload: which agents may lose their provider process, and that the
// manager closes it and resumes the same session on the next send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ProviderId } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { AgentManager } from "../src/agents.ts";
import { keepLoaded, pickUnloads, IdleUnloader, type IdleFacts } from "../src/idle-unload.ts";
import { DEFAULT_IDLE_UNLOAD_MINUTES, Settings } from "../src/settings.ts";
import { AgentPrompt } from "../src/agent-prompt.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

const MIN = 60_000;
const now = 100 * MIN;
const idle = (over: Partial<IdleFacts> = {}): IdleFacts => ({
  agentId: "a", provider: "claude", busy: false, blocked: 0, pending: 0, subagents: 0,
  closing: false, scheduled: false, lastActive: now - 20 * MIN, ...over,
});

test("an agent idle past the threshold may be unloaded", () => {
  assert.equal(keepLoaded(idle(), now, 15 * MIN), null);
  assert.equal(keepLoaded(idle({ lastActive: now - 15 * MIN }), now, 15 * MIN), null);
  assert.equal(keepLoaded(idle({ lastActive: now - 14 * MIN }), now, 15 * MIN), "recently active");
});

test("a threshold of 0 turns idle unload off", () => {
  assert.equal(keepLoaded(idle({ lastActive: 0 }), now, 0), "idle unload is off");
  assert.deepEqual(pickUnloads([idle({ lastActive: 0 })], now, 0, new Set()), []);
});

test("running, waiting, pending, subagents, closing and scheduled agents stay loaded", () => {
  const cases: [Partial<IdleFacts>, string][] = [
    [{ busy: true }, "running"],
    [{ blocked: 1 }, "waiting on a permission or question"],
    [{ pending: 2 }, "has pending messages"],
    [{ subagents: 1 }, "subagents running"],
    [{ closing: true }, "closing"],
    [{ scheduled: true }, "a schedule is running"],
  ];
  for (const [over, reason] of cases) assert.equal(keepLoaded(idle(over), now, 15 * MIN), reason, reason);
});

test("agents of a shared-process provider unload together, only when all may", () => {
  const shared = new Set<ProviderId>(["opencode"]);
  const facts = [
    idle({ agentId: "c1" }),
    idle({ agentId: "o1", provider: "opencode" }),
    idle({ agentId: "o2", provider: "opencode", lastActive: now - MIN }),
  ];
  assert.deepEqual(pickUnloads(facts, now, 15 * MIN, shared), ["c1"]);
  facts[2] = idle({ agentId: "o2", provider: "opencode" });
  assert.deepEqual(pickUnloads(facts, now, 15 * MIN, shared).sort(), ["c1", "o1", "o2"]);
  assert.deepEqual(pickUnloads(facts.slice(1), now, 15 * MIN, new Set()).sort(), ["o1", "o2"]);
});

test("settings default to 15 minutes and keep other config.json keys", (t) => {
  const home = mkdtempSync(join(tmpdir(), "casm-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settings = new Settings(home);
  assert.equal(settings.get().idleUnloadMinutes, DEFAULT_IDLE_UNLOAD_MINUTES);
  assert.equal(DEFAULT_IDLE_UNLOAD_MINUTES, 15);
  writeFileSync(join(home, "config.json"), JSON.stringify({ listen: "127.0.0.1:1" }));
  assert.deepEqual(settings.set({ idleUnloadMinutes: 0 }), { idleUnloadMinutes: 0 });
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { listen: "127.0.0.1:1", idleUnloadMinutes: 0 });
  new AgentPrompt(home).set({ enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { listen: "127.0.0.1:1", idleUnloadMinutes: 0, agentPrompt: false });
  writeFileSync(join(home, "config.json"), JSON.stringify({ idleUnloadMinutes: "soon" }));
  assert.equal(settings.get().idleUnloadMinutes, 15);
  assert.throws(() => new Settings(null).set({ idleUnloadMinutes: 5 }));
});

// An in-process provider: each open() is one "process", answering every prompt.
function fakeProvider(id: ProviderId, sharedProcess = false) {
  const opened: { resumeId: string | null; closed: boolean; opts: OpenOptions }[] = [];
  const provider: Provider = {
    id,
    sharedProcess,
    open(opts) {
      const proc = { resumeId: opts.resumeId, closed: false, opts };
      opened.push(proc);
      return {
        send(_text, _itemId, _images, turnId) {
          opts.emit({ type: "sessionId", id: opts.resumeId ?? `native-${opened.length}` });
          queueMicrotask(() => opts.emit({ type: "turnEnded", outcome: "completed", turnId }));
        },
        shell() {},
        async interrupt() {},
        async close() { proc.closed = true; },
      };
    },
    async history() { return []; },
    async catalog() { return { models: [], modes: [] } as never; },
    async usage() { return null; },
    async commands() { return []; },
  };
  return { provider, opened };
}

function setup(t: import("node:test").TestContext, providers: Provider[]) {
  const dir = mkdtempSync(join(tmpdir(), "casm-idle-"));
  const store = new Store(join(dir, "db"));
  const changes: Agent[] = [];
  const manager = new AgentManager(store, new Map(providers.map((p) => [p.id, p])), (name, params) => {
    if (name === "agent.changed") changes.push((params as { agent: Agent }).agent);
  });
  t.after(async () => {
    await manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "p", path: dir });
  const agent = (provider: ProviderId) => store.createAgent({ projectId: project.id, name: provider, provider, cwd: dir, config: {} });
  const view = (id: string) => manager.withStatus(store.getAgent(id)!);
  return { store, manager, agent, view, changes };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("the manager unloads an idle agent and the next send resumes its session", async (t) => {
  const { provider, opened } = fakeProvider("claude");
  const { manager, agent, view, changes } = setup(t, [provider]);
  const a = agent("claude");
  assert.equal(view(a.id).loaded, false);
  manager.send(a.id, { text: "hi" });
  await settle();
  assert.equal(view(a.id).loaded, true);
  assert.equal(view(a.id).status, "idle");
  // Not idle long enough yet.
  let minutes = 15;
  const unloader = new IdleUnloader(manager, () => minutes, 60 * MIN);
  t.after(() => unloader.stop());
  unloader.check();
  assert.equal(opened[0].closed, false);
  // Off: nothing happens however long it idles.
  backdate(manager, a.id, 60 * MIN);
  minutes = 0;
  unloader.check();
  assert.equal(opened[0].closed, false);
  minutes = 15;
  changes.length = 0;
  unloader.check();
  assert.equal(opened[0].closed, true);
  assert.equal(view(a.id).loaded, false);
  assert.equal(view(a.id).status, "idle");
  assert.equal(changes.at(-1)?.loaded, false, "clients hear that it unloaded");
  manager.send(a.id, { text: "again" });
  await settle();
  assert.equal(opened.length, 2);
  assert.equal(opened[1].resumeId, "native-1", "resumes the same native session");
  assert.equal(view(a.id).loaded, true);
});

test("the manager keeps agents with pending messages or a running turn", async (t) => {
  const { provider, opened } = fakeProvider("claude");
  const { manager, agent, store } = setup(t, [provider]);
  const a = agent("claude");
  manager.send(a.id, { text: "hi" });
  await settle();
  store.addPending({ agentId: a.id, text: "later", reason: "failed", notBefore: null, note: "boom" });
  backdate(manager, a.id, 60 * MIN);
  const unloader = new IdleUnloader(manager, () => 15, 60 * MIN);
  t.after(() => unloader.stop());
  unloader.check();
  assert.equal(opened[0].closed, false);
  assert.deepEqual(manager.idleFacts().map((f) => f.pending), [1]);
  // unloadIdle re-checks what it can see itself: a running turn is never cut.
  const b = agent("claude");
  manager.send(b.id, { text: "hold on" });
  (manager as unknown as { live: Map<string, { turnId: string }> }).live.get(b.id)!.turnId = "hold";
  manager.unloadIdle([b.id]);
  assert.equal(opened[1].closed, false);
});

test("OpenCode agents unload only when all of them are idle", async (t) => {
  const { provider, opened } = fakeProvider("opencode", true);
  const { manager, agent, view } = setup(t, [provider]);
  const [a, b] = [agent("opencode"), agent("opencode")];
  manager.send(a.id, { text: "hi" });
  manager.send(b.id, { text: "hi" });
  await settle();
  backdate(manager, a.id, 60 * MIN);
  const unloader = new IdleUnloader(manager, () => 15, 60 * MIN);
  t.after(() => unloader.stop());
  unloader.check();
  assert.deepEqual(opened.map((o) => o.closed), [false, false]);
  backdate(manager, b.id, 16 * MIN);
  unloader.check();
  assert.deepEqual(opened.map((o) => o.closed), [true, true]);
  assert.equal(view(a.id).loaded, false);
  assert.equal(view(b.id).loaded, false);
});

function backdate(manager: AgentManager, id: string, ms: number) {
  (manager as unknown as { live: Map<string, { lastActive: number }> }).live.get(id)!.lastActive = Date.now() - ms;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { AgentManager } from "../src/agents.ts";
import { mergeHistorySupplements } from "../src/history-supplements.ts";
import { approvalReview } from "../src/providers/codex-reviews.ts";
import type { Provider } from "../src/providers/types.ts";

test("review history persists final upserts across server/store reopen, restart, pagination and agent isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-review-history-"));
  let store = new Store(join(dir, "state.db"));
  const project = store.createProject({ name: "test", path: dir });
  const agent = store.createAgent({ projectId: project.id, name: "a", provider: "codex", cwd: dir, config: {} });
  const other = store.createAgent({ projectId: project.id, name: "b", provider: "codex", cwd: dir, config: {} });
  const native: Item[] = [{ kind: "user", id: "u", text: "test" }, { kind: "tool", id: "cmd", name: "shell", input: "npm test", status: "done" }];
  const provider: Provider = {
    id: "codex", async history() { return native; }, async catalog() { return { models: [], modes: [] }; }, async commands() { return []; }, async usage() { return null; },
    open(o) {
      o.emit({ type: "sessionId", id: "native" });
      return { send() {
        for (const status of ["inProgress", "approved"]) o.emit({ type: "item", item: approvalReview({ reviewId: "r", targetItemId: "cmd", review: { status }, action: { type: "command", command: "npm test" } })!, history: { beforeItemId: "cmd" } });
        setImmediate(() => o.emit({ type: "turnEnded", outcome: "completed" }));
      }, shell() {}, async interrupt() {}, async close() {} };
    },
  };
  let manager = new AgentManager(store, new Map([["codex", provider]]), () => {});
  try {
    manager.send(agent.id, { text: "test" });
    await manager.wait(agent.id);
    const first = await manager.history(agent.id);
    assert.deepEqual(first.items.map(i => i.id), ["u", "review:r", "cmd"]);
    assert.equal(first.items[1].kind === "tool" && first.items[1].name, "Review approved");
    assert.ok(first.items[1].at);
    assert.equal(store.historySupplements(agent.id, "native").length, 1);
    assert.deepEqual(store.historySupplements(other.id, "native"), []);
    assert.deepEqual(store.historySupplements(agent.id, "other-session"), []);
    await manager.shutdown(); store.close();
    store = new Store(join(dir, "state.db"));
    manager = new AgentManager(store, new Map([["codex", provider]]), () => {});
    assert.deepEqual(await manager.history(agent.id), first);
    assert.deepEqual((await manager.history(agent.id, 2, 1)).items, [first.items[1]]);
    await manager.restart(agent.id);
    const past = (await manager.history(agent.id)).items;
    assert.deepEqual(past.slice(0, 3).map(i => i.id), ["past0:u", "past0:review:r", "past0:cmd"]);
    store.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    assert.deepEqual(store.historySupplements(agent.id, "native"), []);
  } finally { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unanchored and unfinished reviews retain native order and never invent an approval", () => {
  const review = approvalReview({ reviewId: "r", review: { status: "inProgress" }, action: { type: "networkAccess", host: "example.com", port: 443, protocol: "https" }, startedAtMs: 1700000001000 })!;
  const native: Item[] = [{ kind: "user", id: "u", text: "hi", at: "2023-11-14T22:13:20.000Z" }, { kind: "assistant", id: "a", text: "done", at: "2023-11-14T22:13:22.000Z" }];
  const merged = mergeHistorySupplements(native, [{ item: review }]);
  assert.deepEqual(merged.map(i => i.id), ["u", "review:r", "a"]);
  assert.ok(merged[1].kind === "tool" && merged[1].status === "error" && merged[1].output?.includes("unknown"));
  assert.equal(mergeHistorySupplements([], [{ item: review }], new Set([review.id]))[0], review);
  assert.deepEqual(mergeHistorySupplements([review], [{ item: review }]), [review]);
});

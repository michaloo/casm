import { test } from "node:test";
import assert from "node:assert/strict";
import { RECALL_MS, newMessageId, pendingLabel, queueHeld, recallable, sendMode, visiblePending } from "../src/outbox.ts";

const row = (id: string, reason: "queued" | "limit" | "failed" = "queued") => ({ id, agentId: "a", text: id, reason, createdAt: "" });

test("message ids are v4 UUIDs the server accepts", () => {
  const ids = new Set(Array.from({ length: 50 }, newMessageId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the visible queue hides rows being taken out and adds unconfirmed ones once", () => {
  const c = { pending: [row("a"), row("b")], outbox: [row("b"), row("c")], hidden: new Set(["a"]) };
  assert.deepEqual(visiblePending(c).map((p) => p.id), ["b", "c"]);
});

test("Enter queues behind a busy agent or waiting messages", () => {
  assert.equal(sendMode("idle", 0), "send");
  assert.equal(sendMode(undefined, 0), "send");
  assert.equal(sendMode("idle", 1), "queue");
  assert.equal(sendMode("running", 0), "queue");
  assert.equal(sendMode("waiting", 0), "queue");
});

test("failed and limited rows offer Retry now and hold the queue", () => {
  assert.deepEqual(pendingLabel({ ...row("x", "failed"), note: "provider unreachable" }), { status: "Not delivered · provider unreachable", action: "retry" });
  assert.equal(pendingLabel(row("y", "limit")).action, "retry");
  const retrying = { ...row("r", "failed"), note: "agent process exited", notBefore: "2026-10-18T20:01:40Z", retry: { attempt: 2, of: 3 } };
  assert.deepEqual(pendingLabel(retrying, Date.parse("2026-10-18T20:00:00Z")),
    { status: "Retrying in 1m 40s (attempt 2 of 3) · agent process exited", action: "retry" });
  assert.equal(pendingLabel(retrying, Date.parse("2026-10-18T20:05:00Z")).status, "Retrying now (attempt 2 of 3) · agent process exited");
  assert.deepEqual(pendingLabel(row("z")), { status: "Queued", action: "send-now" });
  assert.equal(queueHeld([row("x", "failed"), row("z")]), true);
  assert.equal(queueHeld([row("z"), row("x", "failed")]), false);
});

test("Esc takes back only a message still queued or running its own turn", () => {
  const recall = { id: "m", at: 1000, ended: 2 };
  const base = { pending: [], items: [{ kind: "user", id: "m" }], recall, turnsEnded: 2 };
  assert.equal(recallable({ ...base, pending: [row("m")] }, "running", 1000), "queued");
  assert.equal(recallable({ ...base, items: [], inFlight: new Map([["m", {}]]) }, "idle", 1000), "running");
  assert.equal(recallable(base, "running", 1000), "running");
  // Answered, or its turn ended and another runs, or someone wrote since, or too late.
  assert.equal(recallable(base, "idle", 1000), undefined);
  assert.equal(recallable({ ...base, turnsEnded: 3 }, "running", 1000), undefined);
  assert.equal(recallable({ ...base, items: [...base.items, { kind: "user", id: "other" }] }, "running", 1000), undefined);
  assert.equal(recallable(base, "running", 1000 + RECALL_MS + 1), undefined);
  assert.equal(recallable({ ...base, recall: undefined }, "running", 1000), undefined);
});

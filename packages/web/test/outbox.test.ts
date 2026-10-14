import { test } from "node:test";
import assert from "node:assert/strict";
import { newMessageId, pendingLabel, queueHeld, sendMode, visiblePending } from "../src/outbox.ts";

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
  assert.deepEqual(pendingLabel(row("z")), { status: "Queued", action: "send-now" });
  assert.equal(queueHeld([row("x", "failed"), row("z")]), true);
  assert.equal(queueHeld([row("z"), row("x", "failed")]), false);
});

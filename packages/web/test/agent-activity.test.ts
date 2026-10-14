import { test } from "node:test";
import assert from "node:assert/strict";
import { agentActivity } from "../src/agent-activity.ts";

test("only active execution displays Working; deferred and disconnected states do not", () => {
  assert.deepEqual(agentActivity({ status: "running", deferred: null }), { label: "Working", working: true });
  assert.deepEqual(agentActivity({ status: "waiting", deferred: null }), { label: "Needs you", working: false });
  const deferred = { until: "2026-10-14T12:00:00Z", reason: "429 Too Many Requests" };
  assert.deepEqual(agentActivity({ status: "idle", deferred }), { label: "Rate limited", working: false });
  assert.deepEqual(agentActivity({ status: "running", deferred: null }, "running", false), { label: "Offline", working: false });
  assert.deepEqual(agentActivity({ status: "idle", deferred: null }), { label: "Idle", working: false });
  // A pending-message failure is not an active loading state.
  assert.deepEqual(agentActivity({ status: "idle", deferred: null }, "failed"), { label: "Failed", working: false });
});

test("one status dot represents execution, held queues, and offline state", async () => {
  const { agentStatus } = await import("../src/agent-activity.ts");
  const agent = { status: "idle" as const, deferred: null, pending: { count: 2, held: { reason: "failed" as const, note: "Provider failed" } } };
  assert.deepEqual(agentStatus(agent), { kind: "failed", label: "Queue needs retry", detail: "Queue needs retry · Provider failed" });
  assert.equal(agentStatus(agent, "failed").kind, "failed");
  assert.equal(agentStatus(agent, "running").kind, "running");
  assert.equal(agentStatus(agent, "waiting").label, "Needs you");
  assert.equal(agentStatus(agent, "running", false).kind, "offline");
  assert.equal(agentStatus({ ...agent, pending: { count: 2, held: { reason: "limit" } } }).kind, "limited");
  assert.equal(agentStatus({ ...agent, pending: { count: 2, held: { reason: "limit" } } }, "failed").kind, "failed");
});

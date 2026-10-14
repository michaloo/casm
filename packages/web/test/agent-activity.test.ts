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

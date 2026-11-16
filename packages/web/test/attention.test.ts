import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@casm/protocol";
import { waitingAgents } from "../src/attention.ts";

test("attention includes waiting children from other projects, excludes offline and expired requests", () => {
  const child = { id: "child", name: "Browser approval", projectId: "other-project", status: "waiting", archivedAt: null, parent: { agentId: "parent" } } as Agent;
  const hosts = [{ id: "local", name: "Laptop", agents: [child] }];
  assert.deepEqual(waitingAgents(hosts), [{ host: "local", hostName: "Laptop", project: "other-project", id: "child", name: "Browser approval" }]);
  assert.deepEqual(waitingAgents([{ ...hosts[0], error: "offline" }]), []);
  assert.deepEqual(waitingAgents([{ ...hosts[0], agents: [{ ...child, status: "idle" }] }]), []);
  assert.deepEqual(waitingAgents([{ ...hosts[0], agents: [{ ...child, archivedAt: "2026-11-13" }] }]), []);
});

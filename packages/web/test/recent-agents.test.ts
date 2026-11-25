import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@casm/protocol";
import { agentActivity, recentProjectAgents } from "../src/recent-agents.ts";
import { agentHierarchy } from "../src/agent-hierarchy.ts";

test("keeps the five newest chats, plus an older selected chat", () => {
  const agents = Array.from({ length: 9 }, (_, id) => ({
    id: String(id),
    projectId: id === 7 ? "other" : "project",
    archivedAt: id === 8 ? "archived" : null,
    createdAt: new Date(id * 1000).toISOString(),
  } as Agent));
  assert.deepEqual(recentProjectAgents(agents, "project").map(a => a.id), ["6", "5", "4", "3", "2"]);
  assert.deepEqual(recentProjectAgents(agents, "project", "0").map(a => a.id), ["6", "5", "4", "3", "2", "0"]);
  assert.deepEqual(recentProjectAgents(agents, "project", "5").map(a => a.id), ["6", "5", "4", "3", "2"]);
  assert.deepEqual(recentProjectAgents(agents, "project", "8").map(a => a.id), ["6", "5", "4", "3", "2"]);
});

test("activity orders the preview and full list, even when the latest chat was created first", () => {
  const chats = ["Zebra", "Alpha", "Bravo", "Charles", "Delta", "Echo"].map((name, i) => ({
    id: String(i), name, projectId: "project", archivedAt: null,
    createdAt: new Date(i * 1000).toISOString(),
    updatedAt: new Date((i === 0 ? 10 : i) * 1000).toISOString(),
  } as Agent));
  const recent = recentProjectAgents(chats, "project");
  assert.deepEqual(recent.map(a => a.id), ["0", "5", "4", "3", "2"]);
  assert.deepEqual(agentHierarchy(recent, "project", null, agentActivity).map(row => row.agent.id), ["0", "5", "4", "3", "2"]);
  assert.deepEqual(agentHierarchy(chats, "project", null, agentActivity).map(row => row.agent.id), ["0", "5", "4", "3", "2", "1"]);
});

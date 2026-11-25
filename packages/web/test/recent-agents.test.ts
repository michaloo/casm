import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@casm/protocol";
import { agentActivity, lastMessageTime, recentProjectAgents } from "../src/recent-agents.ts";
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

test("message time orders both lists without treating metadata or tool events as messages", () => {
  const chats = ["Zebra", "Alpha", "Bravo", "Charles", "Delta", "Echo"].map((name, i) => ({
    id: String(i), name, projectId: "project", archivedAt: null,
    createdAt: new Date(i * 1000).toISOString(),
    updatedAt: new Date((i === 1 ? 20 : i) * 1000).toISOString(),
  } as Agent));
  const last = lastMessageTime([
    { kind: "assistant", id: "reply", text: "Done", at: new Date(10000).toISOString() },
    { kind: "user", id: "user", text: "One more question", at: new Date(11000).toISOString() },
    { kind: "notice", id: "log", level: "info", text: "Metadata changed", at: new Date(30000).toISOString() },
  ]);
  assert.equal(last, 11000);
  const activity = (agent: Agent) => agentActivity(agent, agent.id === "0" ? last : undefined);
  const recent = recentProjectAgents(chats, "project", undefined, activity);
  assert.deepEqual(recent.map(a => a.id), ["0", "5", "4", "3", "2"]);
  assert.deepEqual(agentHierarchy(recent, "project", null, activity).map(row => row.agent.id), ["0", "5", "4", "3", "2"]);
  assert.deepEqual(agentHierarchy(chats, "project", null, activity).map(row => row.agent.id), ["0", "5", "4", "3", "2", "1"]);
});

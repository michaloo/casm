import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@casm/protocol";
import { recentProjectAgents } from "../src/recent-agents.ts";

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

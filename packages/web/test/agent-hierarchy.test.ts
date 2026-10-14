import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@casm/protocol";
import { agentHierarchy } from "../src/agent-hierarchy.ts";
const agent = (id: string, parent?: string, overrides: Partial<Agent> = {}): Agent => ({
  id, name: id, projectId: "project", provider: "codex", cwd: "/tmp", config: { model: "", mode: "" },
  nativeSessionId: null, parent: parent ? { serverId: "canonical", agentId: parent } : null,
  tags: [], archivedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", status: "idle", ...overrides,
});
const rows = (agents: Agent[], serverId: string | null = "canonical") => agentHierarchy(agents, "project", serverId).map(({ agent, depth }) => [agent.id, depth]);
test("same canonical host and project descendants nest with stable root/sibling sorting", () => {
  const agents = [agent("z"), agent("c", "b"), agent("b", "z"), agent("a", "z"), agent("root")];
  assert.deepEqual(rows(agents), [["root", 0], ["z", 0], ["a", 1], ["b", 1], ["c", 2]]);
  assert.deepEqual(rows([...agents].reverse()), rows(agents));
});
test("cross-host/project children stay in their project and ignore parent host display hints", () => {
  const agents = [agent("p"), agent("cross-host", "p", { parent: { serverId: "other", agentId: "p", host: "canonical" } }),
    agent("cross-project", "p", { projectId: "elsewhere" }), agent("child", "cross-project")];
  assert.deepEqual(rows(agents), [["child", 0], ["cross-host", 0], ["p", 0]]);
  assert.deepEqual(agentHierarchy(agents, "elsewhere", "canonical").map(({ agent, depth }) => [agent.id, depth]), [["cross-project", 0]]);
  assert.ok(rows(agents, null).every(([, depth]) => depth === 0));
});
test("missing and archived parents do not hide children; cycles and self links remain visible", () => {
  const agents = [agent("archived", undefined, { archivedAt: "now" }), agent("orphan", "missing"), agent("visible", "archived"),
    agent("a", "b"), agent("b", "a"), agent("nested", "a"), agent("self", "self")];
  assert.deepEqual(rows(agents), [["a", 0], ["nested", 1], ["b", 0], ["orphan", 0], ["self", 0], ["visible", 0]]);
});
test("equal names sort by createdAt then id without mutating input", () => {
  const agents = [agent("z", undefined, { name: "same", createdAt: "2027-01-01" }), agent("b", undefined, { name: "same" }), agent("a", undefined, { name: "same" })];
  assert.deepEqual(rows(agents), [["a", 0], ["b", 0], ["z", 0]]);
  assert.deepEqual(agents.map((agent) => agent.id), ["z", "b", "a"]);
});

import type { Agent } from "@casm/protocol";

export type AgentHierarchyRow = { agent: Agent; depth: number };
const compare = (a: Agent, b: Agent) =>
  a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Flatten only visible, same-server/project relationships. Each agent appears once. */
export function agentHierarchy(agents: readonly Agent[], projectId: string, serverId: string | null | undefined): AgentHierarchyRow[] {
  const visible = agents.filter((agent) => agent.projectId === projectId && !agent.archivedAt).sort(compare);
  const byId = new Map(visible.map((agent) => [agent.id, agent]));
  const parents = new Map<string, string>();
  for (const agent of visible) {
    if (serverId && agent.parent?.serverId === serverId && byId.has(agent.parent.agentId))
      parents.set(agent.id, agent.parent.agentId);
  }
  // Break every edge within a cycle so malformed data never hides any row.
  const checked = new Set<string>();
  for (const agent of visible) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id: string | undefined = agent.id;
    while (id !== undefined && !checked.has(id)) {
      const cycle = positions.get(id);
      if (cycle !== undefined) {
        for (const member of path.slice(cycle)) parents.delete(member);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = parents.get(id);
    }
    for (const member of path) checked.add(member);
  }
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of visible) {
    const parent = parents.get(agent.id);
    if (parent === undefined) roots.push(agent);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(agent);
      children.set(parent, siblings);
    }
  }
  const result: AgentHierarchyRow[] = [];
  const stack = roots.map((agent) => ({ agent, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    result.push(row);
    const nested = children.get(row.agent.id) ?? [];
    for (let i = nested.length - 1; i >= 0; i--) stack.push({ agent: nested[i], depth: row.depth + 1 });
  }
  return result;
}

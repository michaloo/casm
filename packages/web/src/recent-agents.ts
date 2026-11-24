import type { Agent } from "@casm/protocol";

export const RECENT_AGENT_COUNT = 5;

/** Keep the current conversation reachable even when it is older than the recent list. */
export function recentProjectAgents(agents: readonly Agent[], projectId: string, selected?: string): Agent[] {
  const visible = agents.filter(agent => agent.projectId === projectId && !agent.archivedAt);
  const recent = visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, RECENT_AGENT_COUNT);
  const current = visible.find(agent => agent.id === selected);
  if (current && !recent.includes(current)) recent.push(current);
  return recent;
}

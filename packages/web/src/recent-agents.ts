import type { Agent } from "@casm/protocol";

export const RECENT_AGENT_COUNT = 5;
export type ChatActivity = (agent: Agent) => number;

export function agentActivity(agent: Agent): number {
  return Date.parse(agent.updatedAt) || Date.parse(agent.createdAt) || 0;
}

export function compareRecent(a: Agent, b: Agent, activity: ChatActivity): number {
  return activity(b) - activity(a) || agentActivity(b) - agentActivity(a) ||
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** Keep the current conversation reachable even when it is older than the recent list. */
export function recentProjectAgents(agents: readonly Agent[], projectId: string, selected?: string,
  activity: ChatActivity = agentActivity): Agent[] {
  const visible = agents.filter(agent => agent.projectId === projectId && !agent.archivedAt);
  const recent = visible.sort((a, b) => compareRecent(a, b, activity)).slice(0, RECENT_AGENT_COUNT);
  const current = visible.find(agent => agent.id === selected);
  if (current && !recent.includes(current)) recent.push(current);
  return recent;
}

import type { Agent, Item } from "@casm/protocol";

export const RECENT_AGENT_COUNT = 5;
export type ChatActivity = (agent: Agent) => number;

export function agentActivity(agent: Agent, messageAt?: number): number {
  return messageAt || Date.parse(agent.createdAt) || 0;
}

export function lastMessageTime(items: readonly Item[]): number {
  let latest = 0;
  for (const item of items) {
    if (item.kind === "user" || (item.kind === "assistant" && item.text.trim())) {
      latest = Math.max(latest, Date.parse(item.at ?? "") || 0);
    }
  }
  return latest;
}

export function compareRecent(a: Agent, b: Agent, activity: ChatActivity): number {
  return activity(b) - activity(a) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
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

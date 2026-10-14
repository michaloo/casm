import type { Agent } from "@casm/protocol";

export function agentActivity(agent: Pick<Agent, "status" | "deferred">, status: string = agent.status, online = true) {
  if (!online) return { label: "Offline", working: false };
  if (status === "running") return { label: "Working", working: true };
  if (status === "waiting") return { label: "Needs you", working: false };
  if (agent.deferred) return { label: "Rate limited", working: false };
  if (status === "failed") return { label: "Failed", working: false };
  return { label: "Idle", working: false };
}

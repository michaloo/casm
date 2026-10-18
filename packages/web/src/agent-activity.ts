import type { Agent } from "@casm/protocol";

export function agentActivity(agent: Pick<Agent, "status" | "deferred">, status: string = agent.status, online = true) {
  if (!online) return { label: "Offline", working: false };
  if (status === "running") return { label: "Working", working: true };
  if (status === "waiting") return { label: "Needs you", working: false };
  if (status === "failed") return { label: "Failed", working: false };
  if (agent.deferred) return { label: "Rate limited", working: false };
  return { label: "Idle", working: false };
}

/** Shared sidebar/header status; held queues never look like active execution. */
export function agentStatus(agent: Pick<Agent, "status" | "deferred" | "pending">, status: string = agent.status, online = true) {
  const activity = agentActivity(agent, status, online);
  if (!online) return { kind: "offline", label: "Offline", detail: "Offline" };
  const held = agent.pending?.held;
  if (held && (status === "idle" || (status === "failed" && held.reason === "failed"))) {
    // A transient failure retried automatically waits, like a limit.
    const label = held.reason === "limit" ? "Queue waiting for limit" : held.retryAt ? "Queue retrying" : "Queue needs retry";
    return { kind: held.reason === "failed" && !held.retryAt ? "failed" : "limited", label, detail: [label, held.note].filter(Boolean).join(" · ") };
  }
  return { kind: activity.working ? "running" : activity.label === "Rate limited" ? "limited" : status,
    label: activity.label, detail: [activity.label, agent.deferred?.reason].filter(Boolean).join(" · ") };
}

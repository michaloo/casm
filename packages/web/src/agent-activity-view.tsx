import type { Agent } from "@casm/protocol";
import { agentActivity } from "./agent-activity.ts";

export function AgentActivity({ agent, status, online = true, announce = false }: {
  agent: Pick<Agent, "status" | "deferred">; status?: string; online?: boolean; announce?: boolean;
}) {
  const activity = agentActivity(agent, status, online);
  return <span className="agent-activity" role={announce ? "status" : undefined}>
    {activity.working && <span className="activity-spinner" aria-hidden="true" />}
    {activity.label}
  </span>;
}

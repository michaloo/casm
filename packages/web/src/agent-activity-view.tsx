import type { Agent } from "@casm/protocol";
import { agentStatus } from "./agent-activity.ts";

export function AgentActivity({ agent, status, online = true, announce = false }: {
  agent: Pick<Agent, "status" | "deferred" | "pending">; status?: string; online?: boolean; announce?: boolean;
}) {
  const indicator = agentStatus(agent, status, online);
  return <span className={`dot ${indicator.kind}`} role={announce ? "status" : "img"}
    aria-label={indicator.label} title={indicator.detail} />;
}

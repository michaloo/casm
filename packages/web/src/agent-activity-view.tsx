import type { Agent } from "@casm/protocol";
import { agentStatus } from "./agent-activity.ts";

export function AgentActivity({ agent, status, online = true, announce = false, unread = false }: {
  agent: Pick<Agent, "status" | "deferred" | "pending"> & Partial<Pick<Agent, "loaded" | "archivedAt">>; status?: string; online?: boolean; announce?: boolean; unread?: boolean;
}) {
  const indicator = agentStatus(agent, status, online);
  const urgent = indicator.kind === "waiting" || indicator.kind === "failed";
  const label = unread ? `Unread message. ${indicator.label}` : indicator.label;
  return <span className={`dot ${indicator.kind}${unread && !urgent ? " unread" : ""}`} role={announce ? "status" : "img"}
    aria-label={label} title={unread ? `Unread message. ${indicator.detail}` : indicator.detail} />;
}

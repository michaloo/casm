import type { Agent } from "@casm/protocol";
import { ProviderIcon } from "./provider-icon";
import { AgentActivity } from "./agent-activity-view";

export function AgentSummary({ agent, status, online = true }: { agent: Agent; status: string; online?: boolean }) {
  const counts = [agent.subagents?.running ? `${agent.subagents.running} sub` : "", agent.pending?.count ? `${agent.pending.count} queued` : ""].filter(Boolean).join(" · ");
  return <>
    <ProviderIcon provider={agent.provider} />
    <span className="agent-summary">
      <span className="agent-name" title={[agent.name, counts].filter(Boolean).join(" · ")}>{agent.name}</span>
    </span>
    <span className="agent-end"><AgentActivity agent={agent} status={status} online={online} /></span>
  </>;
}

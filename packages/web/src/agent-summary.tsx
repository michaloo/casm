import type { Agent, ModelInfo } from "@casm/protocol";
import { ProviderIcon, providerNames } from "./provider-icon";
import { AgentActivity } from "./agent-activity-view";
import { agentStatus } from "./agent-activity";
import { modelLabels } from "./model-label";

export function AgentSummary({ agent, status, models = [], online = true }: { agent: Agent; status: string; models?: ModelInfo[]; online?: boolean }) {
  const model = modelLabels(agent.config.model, agent.effectiveModel, models);
  // No reported identity: configured model is a selection, never a session claim.
  const label = model.actual ?? (agent.config.model ? `${model.selectedLabel} (selected)` : model.sessionLabel);
  const counts = [agent.subagents?.running ? `${agent.subagents.running} sub` : "", agent.pending?.count ? `${agent.pending.count} queued` : ""].filter(Boolean).join(" · ");
  const detail = [providerNames[agent.provider], label, counts, model.sessionTitle, agentStatus(agent, status, online).detail].filter(Boolean).join(" · ");
  return <>
    <ProviderIcon provider={agent.provider} />
    <span className="agent-summary">
      <span className="agent-name" title={agent.name}>{agent.name}</span>
      <small className="agent-meta" title={detail}>
        <span className="agent-model">{label}</span>
        {counts && <span className="agent-counts"> · {counts}</span>}
      </small>
    </span>
    <span className="agent-end"><AgentActivity agent={agent} status={status} online={online} /></span>
  </>;
}

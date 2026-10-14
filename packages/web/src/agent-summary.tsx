import type { Agent, ModelInfo } from "@casm/protocol";
import { ProviderIcon, providerNames } from "./provider-icon";
import { modelLabels } from "./model-label";

export function AgentSummary({ agent, status, models = [] }: { agent: Agent; status: string; models?: ModelInfo[] }) {
  const model = modelLabels(agent.config.model, agent.effectiveModel, models);
  // No reported identity: configured model is a selection, never a session claim.
  const label = model.actual ?? (agent.config.model ? `${model.selectedLabel} (selected)` : model.sessionLabel);
  return <>
    <ProviderIcon provider={agent.provider} />
    <span className="agent-summary">
      <span className="agent-name">{agent.name}</span>
      <small title={`${providerNames[agent.provider]} · ${model.sessionTitle}`}>
        <span className="agent-model">{label}</span>
        <span className="agent-status">{agent.pending?.count ? `${agent.pending.count} queued · ` : ""}{agent.subagents?.running ? `${agent.subagents.running} sub · ` : ""}{status === "waiting" ? "needs you" : status}</span>
      </small>
    </span>
    <span className={`dot ${status}`} />
  </>;
}

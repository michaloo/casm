import type { Agent, ModelInfo } from "@casm/protocol";
import { ProviderIcon, providerName } from "./provider-icon";
import { AgentActivity } from "./agent-activity-view";
import { modelLabels } from "./model-label";

export function AgentSummary({ agent, status, models = [], online = true }: { agent: Agent; status: string; models?: ModelInfo[]; online?: boolean }) {
  const held = agent.pending?.held;
  const heldLabel = held?.reason === "failed" ? "Queue needs retry" : "Queue waiting for limit";
  const dotStatus = status === "idle" && held ? held.reason === "failed" ? "failed" : "waiting" : status;
  const model = modelLabels(agent.config.model, agent.effectiveModel, models);
  // No reported identity: configured model is a selection, never a session claim.
  const label = model.actual ?? (agent.config.model ? `${model.selectedLabel} (selected)` : model.sessionLabel);
  return <>
    <ProviderIcon provider={agent.provider} />
    <span className="agent-summary">
      <span className="agent-name" title={agent.name}>{agent.name}</span>
      <small title={`${providerName(agent.provider)} · ${model.sessionTitle}`}>
        <span className="agent-model">{label}</span>
        <span className="agent-status">{agent.pending?.count ? `${agent.pending.count} queued · ` : ""}{agent.subagents?.running ? `${agent.subagents.running} sub · ` : ""}<AgentActivity agent={agent} status={status} online={online} /></span>
      </small>
      {held && <small className={`agent-held ${held.reason}`} title={held.note}>
        <span>{heldLabel}</span>{held.note && <span className="agent-held-note"> · {held.note}</span>}
      </small>}
    </span>
    <span className={`dot ${dotStatus}`} />
  </>;
}

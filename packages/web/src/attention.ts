import type { Agent } from "@casm/protocol";

/** Include other projects and child agents even when their sidebar is collapsed. */
export function waitingAgents(hosts: { id: string; name: string; error?: string; agents: Agent[] }[]) {
  return hosts.filter(h => !h.error).flatMap(h => h.agents
    .filter(a => a.status === "waiting" && !a.archivedAt)
    .map(a => ({ host: h.id, hostName: h.name, project: a.projectId, id: a.id, name: a.name })));
}

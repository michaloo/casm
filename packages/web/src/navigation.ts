import type { Host } from "./state";
export type Selection = { host: string; project: string; id?: string };
export function viewPath(s: Selection, hosts: Host[]): string {
  const host = hosts.find((h) => h.id === s.host)?.name ?? s.host;
  const base = `/h/${encodeURIComponent(host)}`;
  return s.id
    ? `${base}/a/${encodeURIComponent(s.id)}`
    : `${base}/p/${encodeURIComponent(s.project)}/new`;
}
export function resolveView(
  path: string,
  hosts: Host[],
): { selection?: Selection; error?: string } {
  if (path === "/") return {};
  let parts: string[];
  try {
    parts = path.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return { error: "View not found: invalid URL." };
  }
  if (parts[0] !== "h" || !parts[1]) return { error: "View not found." };
  const host = hosts.find((h) => h.name === parts[1]);
  if (!host) return { error: `Host not found: ${parts[1]}.` };
  if (host.error)
    return { error: `Host unavailable: ${host.name}. ${host.error}` };
  if (parts.length === 4 && parts[2] === "a") {
    const agent = host.agents.find((a) => a.id === parts[3] && !a.archivedAt);
    if (!agent && host.loading) return {};
    if (!agent)
      return {
        error: "Agent not found. It may have been archived or deleted.",
      };
    return {
      selection: { host: host.id, project: agent.projectId, id: agent.id },
    };
  }
  if (parts.length === 5 && parts[2] === "p" && parts[4] === "new") {
    const project = host.projects.find(
      (p) => p.id === parts[3] && !p.archivedAt,
    );
    if (!project && host.loading) return {};
    if (!project)
      return {
        error: "Project not found. It may have been archived or deleted.",
      };
    return { selection: { host: host.id, project: project.id } };
  }
  return { error: "View not found." };
}

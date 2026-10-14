const storageKey = "casm.collapsed-projects";
export type CollapsedProjects = Record<string, true>;
export function projectKey(host: string, project: string): string {
  return JSON.stringify([host, project]);
}
export function readCollapsed(storage: Pick<Storage, "getItem">): CollapsedProjects {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, collapsed]) => collapsed === true)) as CollapsedProjects;
  } catch { return {}; }
}
export function writeCollapsed(storage: Pick<Storage, "setItem">, value: CollapsedProjects) {
  try { storage.setItem(storageKey, JSON.stringify(value)); } catch { /* Private browsing or full storage. */ }
}
export function projectExpanded(collapsed: CollapsedProjects, host: string, project: string, selected?: { host: string; project: string; id?: string }): boolean {
  return !collapsed[projectKey(host, project)] || !!(selected?.id && selected.host === host && selected.project === project);
}

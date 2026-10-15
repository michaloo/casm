import type { ModelInfo } from "@casm/protocol";

const context1m = (id: string) => /\[1m\]$/i.test(id);
const baseId = (id: string) => id.replace(/\[1m\]$/i, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
const parts = (id: string) => {
  const base = baseId(id), slash = base.lastIndexOf("/");
  return { namespace: base.slice(0, slash + 1), model: base.slice(slash + 1) };
};
function claudeIdentity(id: string, display = false): { family: string; version?: string } | undefined {
  const text = parts(id).model;
  const match = display
    ? /^(?:Claude\s+)?(opus|sonnet|haiku)(?:\s+(\d+(?:\.\d+)?))?\b/i.exec(text)
    : /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+(?:[-.]\d+)?))?$/i.exec(text);
  if (match) return { family: match[1].toLowerCase(), version: match[2]?.replace("-", ".") };
  // Older Claude IDs put the version before the family.
  const older = /^claude-(\d+(?:[-.]\d+)?)-(opus|sonnet|haiku)$/i.exec(text);
  return older ? { family: older[2].toLowerCase(), version: older[1].replace("-", ".") } : undefined;
}

/** Catalog names are authoritative. Unqualified provider IDs may match only unambiguously. */
export function modelDisplayName(id: string, models: ModelInfo[]): string {
  const describe = (model: ModelInfo) => {
    if (!model.name) return id;
    return context1m(id)
      ? `${model.name.replace(/(?:\s*\[1m\]|\s*[·–]\s*1M(?:\s+context)?|\s*\(1M(?:\s+context)?\))$/i, "").trim()} · 1M`
      : model.name;
  };
  const exact = models.find(model => model.id === id);
  if (exact) return describe(exact);
  if (id === "default") {
    const fallback = models.find(model => model.isDefault);
    return fallback ? describe(fallback) : id;
  }
  const requested = parts(id);
  const sameNamespace = (model: ModelInfo) => {
    const candidate = parts(model.id);
    return !requested.namespace || !candidate.namespace || requested.namespace === candidate.namespace;
  };
  const unique = (candidates: ModelInfo[]) => {
    const contextual = candidates.filter(model => context1m(model.id) === context1m(id));
    const choices = contextual.length ? contextual : candidates;
    return choices.length && new Set(choices.map(describe)).size === 1 ? describe(choices[0]) : undefined;
  };
  // Normalize snapshot dates/context on both sides, keeping qualified identities first.
  const normalized = models.filter(model => baseId(model.id) === baseId(id));
  if (normalized.length) return unique(normalized) ?? id;
  const unqualified = models.filter(model => sameNamespace(model) && parts(model.id).model === requested.model);
  if (unqualified.length) return unique(unqualified) ?? id;
  const claude = claudeIdentity(id);
  if (claude) {
    const aliases = models.filter(model => {
      if (!sameNamespace(model)) return false;
      const identity = claudeIdentity(model.id);
      if (!identity || identity.family !== claude.family) return false;
      const version = identity.version ?? claudeIdentity(model.name ?? "", true)?.version;
      // A current alias must never relabel an older, explicitly reported version.
      return !claude.version || version === claude.version;
    });
    return unique(aliases) ?? id;
  }
  return id;
}

/** Reported session identity is independent of the local next-send selection. */
export function modelLabels(selected: string | null | undefined, effective: string | null | undefined, models: ModelInfo[]) {
  const fallback = models.find((model) => model.isDefault);
  const defaultLabel = effective ? `Default · ${modelDisplayName(effective, models)}`
    : fallback ? `Default · ${fallback.name || fallback.id} (catalog)` : "Default · unresolved";
  const actual = effective ? modelDisplayName(effective, models) : undefined;
  return {
    defaultLabel,
    selectedLabel: selected ? modelDisplayName(selected, models) : defaultLabel,
    sessionLabel: actual ?? (fallback ? `${fallback.name || fallback.id} (catalog default)` : "Model unresolved"),
    sessionTitle: actual ? `Reported session model: ${effective}` : fallback ? "Session model unresolved; catalog default is an estimate" : "Session model unresolved",
    // A selected model can change while a turn is already running.
    showSession: !!actual && !!selected && selected !== effective,
    actual,
  };
}

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

/**
 * The model an id names (its catalog name, so an alias and the id it resolves
 * to agree) and its 1M context when the id says so. Without a [1m] suffix the
 * context is unknown, never "not 1M": Claude reports a natively 1M model such
 * as Opus 5.5 with or without the suffix, and transcripts never record it.
 */
function modelIdentity(id: string, models: ModelInfo[]): { name: string; context1m?: true } | undefined {
  // "default" names whatever the provider picks; it can't be compared.
  if (!id || baseId(id) === "default") return undefined;
  const label = modelDisplayName(id, models);
  const name = label === id ? baseId(id).toLowerCase() : label.replace(/\s*·\s*1M$/, "");
  return context1m(id) ? { name, context1m: true } : { name };
}

/** Whether two ids differ in a way that is known, not just in spelling. */
export function modelsDiffer(a: string | null | undefined, b: string | null | undefined, models: ModelInfo[]): boolean {
  const x = modelIdentity(a ?? "", models), y = modelIdentity(b ?? "", models);
  if (!x || !y) return false;
  if (x.name !== y.name) return true;
  // 1M only counts when both sides know it; today only "is 1M" is ever known.
  return x.context1m !== undefined && y.context1m !== undefined && x.context1m !== y.context1m;
}

/**
 * The reported session model, with the 1M context the agent's configured model
 * asked for when the report leaves it out (the configured model is what casm
 * passed to the session; a report under another model is cleared on change).
 */
export function sessionModel(effective: string | null | undefined, configured: string | null | undefined, models: ModelInfo[]) {
  if (!effective || context1m(effective) || !configured || !context1m(configured)) return effective;
  return modelsDiffer(effective, configured.replace(/\[1m\]$/i, ""), models) ? effective : `${effective}[1m]`;
}

/** Reported session identity is independent of the local next-send selection. */
export function modelLabels(selected: string | null | undefined, reported: string | null | undefined, models: ModelInfo[], configured: string | null | undefined = selected) {
  const effective = sessionModel(reported, configured, models);
  const fallback = models.find((model) => model.isDefault);
  const defaultLabel = effective ? `Default · ${modelDisplayName(effective, models)}`
    : fallback ? `Default · ${fallback.name || fallback.id} (catalog)` : "Default · unresolved";
  const actual = effective ? modelDisplayName(effective, models) : undefined;
  return {
    defaultLabel,
    selectedLabel: selected ? modelDisplayName(selected, models) : defaultLabel,
    sessionLabel: actual ?? (fallback ? `${fallback.name || fallback.id} (catalog default)` : "Model unresolved"),
    sessionTitle: actual ? `Reported session model: ${reported}` : fallback ? "Session model unresolved; catalog default is an estimate" : "Session model unresolved",
    // A selected model can change while a turn is already running. An alias and
    // the id it resolves to are the same model; so is an unknown context size.
    showSession: !!actual && !!selected && modelsDiffer(selected, effective, models),
    actual,
    effective,
  };
}

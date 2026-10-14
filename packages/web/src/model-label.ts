import type { ModelInfo } from "@casm/protocol";

function name(id: string, models: ModelInfo[]): string {
  const exact = models.find((model) => model.id === id);
  if (exact) return exact.name || exact.id;
  // Claude reports dated IDs and context suffixes that may not be catalog entries.
  const base = id.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
  const match = models.find((model) => model.id === base);
  return match ? `${match.name || match.id}${id.endsWith("[1m]") ? " · 1M" : ""}` : id;
}

/** Reported session identity is independent of the local next-send selection. */
export function modelLabels(selected: string | null | undefined, effective: string | null | undefined, models: ModelInfo[]) {
  const fallback = models.find((model) => model.isDefault);
  const defaultLabel = effective ? `Default · ${name(effective, models)}`
    : fallback ? `Default · ${fallback.name || fallback.id} (catalog)` : "Default · unresolved";
  const actual = effective ? name(effective, models) : undefined;
  return {
    defaultLabel,
    selectedLabel: selected ? name(selected, models) : defaultLabel,
    sessionLabel: actual ?? (fallback ? `${fallback.name || fallback.id} (catalog default)` : "Model unresolved"),
    sessionTitle: actual ? `Reported session model: ${effective}` : fallback ? "Session model unresolved; catalog default is an estimate" : "Session model unresolved",
    // A selected model can change while a turn is already running.
    showSession: !!actual && !!selected && selected !== effective,
    actual,
  };
}

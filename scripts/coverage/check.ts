// Checks classifications against inventories and computes coverage numbers.
// Shared by the report generator and packages/protocol/test/coverage.test.ts.
import * as protocol from "../../packages/protocol/src/index.ts";
import { THEMES, type Classification, type ClassificationFile, type Inventory, type Source } from "./lib.ts";

export type CheckResult = {
  source: Source;
  // Inventory ids with no classification.
  unclassified: string[];
  // Classified ids that are no longer in the inventory.
  stale: string[];
  // Malformed classifications (missing reason/note, unknown theme, `to` naming nothing in the protocol).
  invalid: string[];
};

export type Counts = { total: number; mapped: number; ignored: number; gap: number; unclassified: number; pct: number };

// `to` names protocol elements: methods and notifications (`agent.send`),
// schema fields (`AgentConfig.model`) and union members (`Item.tool`,
// `AgentEvent.delta`). Several may be joined with " + ", " / " or ", ".
// `internal` marks plumbing the provider uses with no protocol surface of its own.
export function resolveTarget(token: string): boolean {
  const t = token.trim();
  if (t === "internal") return true;
  if (t in protocol.methods || t in protocol.notifications) return true;
  const m = /^([A-Z][A-Za-z]*)\.([A-Za-z]+)$/.exec(t);
  if (!m) return false;
  type Literal = { def?: { values?: unknown[] } };
  const schema = (protocol as Record<string, unknown>)[m[1]] as
    | { shape?: Record<string, unknown>; def?: { discriminator?: string }; options?: { shape: Record<string, Literal> }[] }
    | undefined;
  if (!schema || typeof schema !== "object") return false;
  if (schema.shape) return m[2] in schema.shape;
  const key = schema.def?.discriminator;
  if (key && schema.options) return schema.options.some((o) => (o.shape[key]?.def?.values ?? []).includes(m[2]));
  return false;
}

export function targets(to: string): string[] {
  return to.split(/\s+[+/]\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
}

function validate(id: string, c: Classification | undefined): string | null {
  if (!c || typeof c !== "object") return `${id}: not an object`;
  switch (c.status) {
    case "mapped": {
      if (!c.to) return `${id}: mapped without "to"`;
      const bad = targets(c.to).filter((t) => !resolveTarget(t));
      return bad.length ? `${id}: "to" names unknown protocol element(s): ${bad.join(", ")}` : null;
    }
    case "ignored":
      return c.reason?.trim() ? null : `${id}: ignored without a reason`;
    case "gap":
      if (!c.note?.trim()) return `${id}: gap without a note`;
      return c.theme in THEMES ? null : `${id}: unknown gap theme "${c.theme}" (use one of ${Object.keys(THEMES).join(", ")})`;
    default:
      return `${id}: unknown status "${(c as { status?: string }).status}"`;
  }
}

export function check(inv: Inventory, cls: ClassificationFile | null): CheckResult {
  const items = cls?.items ?? {};
  const ids = new Set(inv.items.map((i) => i.id));
  return {
    source: inv.source,
    unclassified: [...ids].filter((id) => !(id in items)),
    stale: Object.keys(items).filter((id) => !ids.has(id)),
    invalid: Object.entries(items)
      .map(([id, c]) => validate(id, c))
      .filter((e): e is string => !!e),
  };
}

export function counts(inv: Inventory, cls: ClassificationFile | null): Counts {
  const items = cls?.items ?? {};
  const c: Counts = { total: inv.items.length, mapped: 0, ignored: 0, gap: 0, unclassified: 0, pct: 0 };
  for (const { id } of inv.items) {
    const s = items[id]?.status;
    if (s === "mapped" || s === "ignored" || s === "gap") c[s]++;
    else c.unclassified++;
  }
  const denom = c.total - c.ignored;
  c.pct = denom ? (100 * c.mapped) / denom : 100;
  return c;
}

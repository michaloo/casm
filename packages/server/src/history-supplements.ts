import type { Item } from "@casm/protocol";

// Only provider events missing from native history are stored here, not a copy
// of the provider transcript. Stable IDs let a final result replace a start.
export type HistorySupplement = { item: Item; beforeItemId?: string };

export function mergeHistorySupplements(native: Item[], supplements: HistorySupplement[], liveIds: ReadonlySet<string> = new Set()): Item[] {
  const ids = new Set(native.map(i => i.id));
  const before = new Map<string, Item[]>();
  const unanchored: Item[] = [];
  for (const entry of supplements) {
    if (ids.has(entry.item.id)) continue;
    let item = entry.item;
    if (!liveIds.has(item.id) && item.kind === "tool" && item.status === "running")
      item = { ...item, status: "error", output: item.id.startsWith("review:") ? "Final outcome not recorded before the session closed. Approval or denial is unknown." : `${item.output ? item.output + "\n" : ""}Final outcome not recorded before the session closed.` };
    if (entry.beforeItemId && ids.has(entry.beforeItemId)) {
      const group = before.get(entry.beforeItemId) ?? [];
      group.push(item);
      before.set(entry.beforeItemId, group);
    } else unanchored.push(item);
  }
  // Native order is authoritative. Insert unanchored reviews by time without
  // reordering native items, including untimed legacy history.
  unanchored.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const out: Item[] = [];
  let index = 0;
  for (const item of native) {
    while (index < unanchored.length && item.at && unanchored[index].at && unanchored[index].at! <= item.at)
      out.push(unanchored[index++]);
    out.push(...before.get(item.id) ?? [], item);
  }
  out.push(...unanchored.slice(index));
  return out;
}

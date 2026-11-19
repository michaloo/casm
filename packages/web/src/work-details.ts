import type { Item } from "@casm/protocol";

export type WorkView = "compact" | "detailed";
const storageKey = "casm.work-view";
export function readWorkView(storage: Pick<Storage, "getItem">): WorkView {
  try { return storage.getItem(storageKey) === "detailed" ? "detailed" : "compact"; }
  catch { return "compact"; }
}
export function writeWorkView(storage: Pick<Storage, "setItem">, value: WorkView) {
  try { storage.setItem(storageKey, value); } catch { /* Optional device preference. */ }
}
export type TranscriptRow = { id: string; start: number; items: Item[]; work: boolean };
// Earlier Codex sessions reported successful reviews as warning notices.
// Recognize only this exact routine outcome; other warnings and failures stay visible.
function routineReviewNotice(item: Extract<Item, { kind: "notice" }>) {
  if (item.restart || item.level === "error") return false;
  return /^Automatic approval review approved(?:$|\s*[:(])/.test(item.text)
    || (item.id.startsWith("strict-review:") && item.text === "Codex requires a fresh automatic approval review for this turn.");
}
function technicalActivity(item: Item) {
  if (item.kind === "notice") return routineReviewNotice(item);
  // An explicit review failure must remain visible even when tools are grouped.
  if (item.kind === "tool" && item.id.startsWith("review:") && item.status === "error") return false;
  return item.kind === "tool" || item.kind === "reasoning" || item.kind === "subagent";
}
// Messages, plans and actionable notices keep their original order and visibility.
export function transcriptRows(items: Item[], view: WorkView): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const [start, item] of items.entries()) {
    const work = view === "compact" && technicalActivity(item);
    const previous = rows.at(-1);
    if (work && previous?.work) previous.items.push(item);
    else rows.push({ id: work ? `work:${item.id}` : item.id, start, items: [item], work });
  }
  return rows;
}
// Source offsets remain the persisted scroll position and the server's find
// coordinates, even when several source items share one visible row.
export function rowAt(rows: TranscriptRow[], source: number) {
  return Math.max(0, rows.findLastIndex((row) => row.start <= source));
}
export type RowAnchor = { first: number; rows: TranscriptRow[] };
export function anchorRows(rows: TranscriptRow[], start: number, previous?: RowAnchor): RowAnchor {
  if (previous) {
    const offsets = new Map(previous.rows.map((row, index) => [row.id, index]));
    for (const [index, row] of rows.entries()) {
      const before = offsets.get(row.id);
      if (before !== undefined) return { first: previous.first + before - index, rows };
    }
  }
  return { first: 100000 + start, rows };
}

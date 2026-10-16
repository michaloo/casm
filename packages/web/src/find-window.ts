import type { Item } from "@casm/protocol";
import type { Chat } from "./state";

// A jump to a match older than the loaded transcript shows a window of history
// around it instead of loading everything in between. The live transcript
// (c.items from c.start to the end) keeps taking live events meanwhile; the
// window pages older and newer on its own, and joins it once they meet.
// Pages come in as kept in memory (state.ts hold()).
export type HistoryPage = { items: Item[]; start: number };
export const WINDOW_PAGE = 100;

// Where in the shown rows (the window's, else the live ones) history index `index` is.
export function shownIndex(c: Chat, itemId: string, index: number): number {
  const rows = c.window?.items ?? c.items;
  const at = rows.findIndex((i) => i.id === itemId);
  if (at >= 0) return at;
  const offset = index - (c.window?.start ?? c.start);
  return offset >= 0 && offset < rows.length ? offset : -1;
}

// The page `agent.history` should read to show `index`: half a page each side.
export function pageAround(index: number) {
  return { before: index + WINDOW_PAGE / 2, limit: WINDOW_PAGE };
}

// Shows `page`: prepended to the live transcript when it reaches it, else as the window.
export function showPage(c: Chat, page: HistoryPage) {
  const end = page.start + page.items.length;
  if (end >= c.start) {
    const known = new Set(c.items.map((i) => i.id));
    c.items = [...page.items.slice(0, Math.max(0, c.start - page.start)).filter((i) => !known.has(i.id)), ...c.items];
    c.start = Math.min(c.start, page.start);
    c.window = undefined;
    return "live" as const;
  }
  c.window = { items: page.items, start: page.start };
  return "window" as const;
}

export function windowOlder(c: Chat, page: HistoryPage) {
  const w = c.window;
  if (!w) return;
  const known = new Set(w.items.map((i) => i.id));
  w.items = [...page.items.filter((i) => !known.has(i.id)), ...w.items];
  w.start = Math.min(w.start, page.start);
}

// Appends the next page to the window; once it reaches the live transcript the
// two become one (the window's rows keep their places, so nothing jumps).
export function windowNewer(c: Chat, page: HistoryPage) {
  const w = c.window;
  if (!w) return;
  const end = w.start + w.items.length;
  const fresh = page.items.slice(Math.max(0, end - page.start));
  if (page.start + page.items.length >= c.start) {
    const known = new Set([...w.items, ...c.items].map((i) => i.id));
    const between = fresh.slice(0, Math.max(0, c.start - end)).filter((i) => !known.has(i.id));
    c.items = [...w.items, ...between, ...c.items];
    c.start = w.start;
    c.window = undefined;
    return;
  }
  const known = new Set(w.items.map((i) => i.id));
  w.items = [...w.items, ...fresh.filter((i) => !known.has(i.id))];
}

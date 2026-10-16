import { useEffect, useRef, useState } from "react";
import type { FindMatch, Result } from "@casm/protocol";
import { CloseGlyph, SearchGlyph } from "./launcher";
import { ChevronGlyph } from "./row-menu";

// Find in this chat: agent.find searches the whole history on the server (the
// web client holds only pages of it, and Virtuoso renders only what is near
// the viewport); the transcript jumps to each match and highlights the
// rendered ones with the CSS Custom Highlight API, without touching the DOM.

// The server's rule: a capital letter makes the query case-sensitive.
export function findPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), query !== query.toLowerCase() ? "g" : "gi");
}

// The match the transcript should show; `ordinal`: which occurrence within its item.
export type FindTarget = { match: FindMatch; ordinal: number; seq: number };
export type FindState = { query: string; target?: FindTarget };

export const FILTERS = {
  all: { label: "All", kinds: undefined },
  messages: { label: "Messages", kinds: ["user", "assistant", "notice", "plan", "subagent"] },
  tools: { label: "Tools", kinds: ["tool"] },
  thinking: { label: "Thinking", kinds: ["reasoning"] },
} as const satisfies Record<string, { label: string; kinds?: readonly FindMatch["kind"][] }>;
export type FindFilter = keyof typeof FILTERS;

export function FindGlyph() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M3.5 5h13M3.5 9h6M3.5 13h4" /><circle cx="13.25" cy="12.75" r="3" /><path d="m15.5 15 2 2" />
  </svg>;
}

// The bar's own state; `change` tells the transcript what to show. It starts
// at the newest match: Enter steps back through older ones, Shift+Enter forward.
export function FindBar({ search, change, close, focusKey }: {
  search: (query: string, kinds?: readonly FindMatch["kind"][]) => Promise<Result<"agent.find">>;
  change: (state: FindState) => void;
  close: () => void;
  // Changes when ⌘F is pressed again: focus and select the query.
  focusKey: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FindFilter>("all");
  const [result, setResult] = useState<Result<"agent.find">>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(-1);
  const seq = useRef(0);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);
  useEffect(() => {
    const q = query;
    const asked = ++seq.current;
    if (!q) {
      setResult(undefined); setLoading(false); setError(""); setCurrent(-1);
      change({ query: "" });
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      search(q, FILTERS[filter].kinds).then((r) => {
        if (seq.current !== asked) return;
        setResult(r); setError(""); setLoading(false);
        go(r, r.matches.length - 1, q);
      }, (e) => {
        if (seq.current !== asked) return;
        setResult(undefined); setLoading(false); setError(String((e as Error).message));
        change({ query: q });
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, filter]);
  const targets = useRef(0);
  function go(r: Result<"agent.find"> | undefined, at: number, q = query) {
    if (!r?.matches.length) { setCurrent(-1); change({ query: q }); return; }
    const i = (at + r.matches.length) % r.matches.length;
    setCurrent(i);
    const match = r.matches[i];
    let ordinal = 0;
    for (let j = i - 1; j >= 0 && r.matches[j].itemId === match.itemId; j--) ordinal++;
    change({ query: q, target: { match, ordinal, seq: ++targets.current } });
  }
  const count = result?.matches.length ?? 0;
  // Numbered in time order over all of them; only the newest `limit` come back.
  const number = result && current >= 0 ? result.total - count + current + 1 : 0;
  const status = !query ? "" : loading ? "Searching…" : error ? "Search failed" : !result?.total ? "No matches" : `${number} of ${result.total}`;
  return <div className="find-bar chat-column" role="search" aria-label="Find in chat">
    <SearchGlyph />
    <input ref={input} type="search" aria-label="Find in chat" placeholder="Find in chat" value={query} title={error || undefined}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search"
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Enter") { e.preventDefault(); go(result, current + (e.shiftKey ? 1 : -1)); }
      }} />
    <span className={`find-count${error ? " error" : ""}`} role="status" aria-live="polite">{status}</span>
    <select aria-label="Search in" value={filter} onChange={(e) => setFilter(e.target.value as FindFilter)}>
      {Object.entries(FILTERS).map(([value, f]) => <option key={value} value={value}>{f.label}</option>)}
    </select>
    <button type="button" className="find-step older" aria-label="Older match" title="Older match (Enter)" disabled={!count}
      onClick={() => go(result, current - 1)}><ChevronGlyph /></button>
    <button type="button" className="find-step newer" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={!count}
      onClick={() => go(result, current + 1)}><ChevronGlyph /></button>
    <button type="button" className="find-close" aria-label="Close find" title="Close (Esc)" onClick={close}><CloseGlyph /></button>
  </div>;
}

const ALL = "casm-find";
const CURRENT = "casm-find-current";
const highlights = () => (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

// Text the server does not search (labels, buttons, times, the one-line
// summary of an open tool: its input shows in full below), and what a closed
// row hides.
const SKIP = "button, time, [aria-hidden=true], .message-role, .row-kind, .code-toolbar, .status, details[open] > summary, details:not([open]) > :not(summary)";

// Occurrences of `pattern` in one rendered row, as Ranges (they may span the
// spans syntax highlighting splits a line into).
export function rowRanges(row: Element, pattern: RegExp): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  const at = (offset: number, end: boolean): [Text, number] => {
    // The last node starting before (or, for an end, at) the offset.
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] < offset || (!end && starts[mid] === offset)) lo = mid; else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };
  const out: Range[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const range = document.createRange();
    range.setStart(...at(m.index, false));
    range.setEnd(...at(m.index + m[0].length, true));
    out.push(range);
  }
  return out;
}

const rowOf = (scroller: HTMLElement, itemId: string) => scroller.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);

// Highlights every match in the rendered rows, and `current` more strongly.
export function highlightMatches(scroller: HTMLElement, pattern: RegExp, current?: { itemId: string; ordinal: number }) {
  const registry = highlights();
  if (!registry || !Highlight) return;
  const others: Range[] = [];
  let strong: Range | undefined;
  for (const row of scroller.querySelectorAll<HTMLElement>("[data-item-id]")) {
    const ranges = rowRanges(row, pattern);
    if (current && row.dataset.itemId === current.itemId && ranges.length) {
      const i = Math.min(current.ordinal, ranges.length - 1);
      strong = ranges[i];
      ranges.splice(i, 1);
    }
    others.push(...ranges);
  }
  registry.set(ALL, new Highlight(...others));
  registry.set(CURRENT, strong ? new Highlight(strong) : new Highlight());
}

export function clearHighlights() {
  highlights()?.delete(ALL);
  highlights()?.delete(CURRENT);
}

const frame = () => new Promise((r) => requestAnimationFrame(r));

// Scrolls `range` to about a third from the top of each scrolling box it is
// in (a long code block, then the transcript), unless it is in view already.
function bringIntoView(range: Range, scroller: HTMLElement) {
  for (let el = range.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
    const style = getComputedStyle(el);
    const r = range.getBoundingClientRect(), box = el.getBoundingClientRect();
    if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && (r.top < box.top || r.bottom > box.bottom))
      el.scrollTop += r.top - box.top - el.clientHeight / 3;
    if (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && (r.left < box.left || r.right > box.right))
      el.scrollLeft += r.left - box.left - el.clientWidth / 3;
  }
  const r = range.getBoundingClientRect(), box = scroller.getBoundingClientRect();
  // The find bar covers the top and the composer the bottom.
  if (r.top < box.top + 64 || r.bottom > box.bottom - 120) scroller.scrollTop += r.top - box.top - scroller.clientHeight / 3;
}

// Once Virtuoso has scrolled the match's row in: opens what hides the match
// (a collapsed tool or Thinking row, a clamped text, a long output cut short),
// then scrolls the occurrence itself into view. False when the row never came.
// `scroll` returns the transcript's scroller: Virtuoso may be remounting.
export async function revealMatch(scroll: () => HTMLElement | null, target: FindTarget, pattern: RegExp, current: () => boolean) {
  for (let round = 0, opened = 0; round < 60 && current(); round++) {
    const scroller = scroll();
    const row = scroller && rowOf(scroller, target.match.itemId);
    if (!row) { await frame(); continue; }
    const ranges = rowRanges(row, pattern);
    if (ranges.length <= target.ordinal && opened < 4) {
      const closed = row.querySelector<HTMLDetailsElement>("details:not([open])");
      const more = row.querySelector<HTMLButtonElement>("button[aria-expanded=false]");
      if (closed || more) {
        if (closed) closed.open = true; else more!.click();
        opened++;
        await frame(); await frame();
        continue;
      }
    }
    const range = ranges[Math.min(target.ordinal, ranges.length - 1)];
    if (range) {
      highlightMatches(scroller, pattern, { itemId: target.match.itemId, ordinal: target.ordinal });
      bringIntoView(range, scroller);
      // Rows above may still settle their heights: check once more.
      await frame(); await frame();
      if (current() && range.getClientRects().length) bringIntoView(range, scroller);
    }
    return true;
  }
  return false;
}

// Keeps the highlights on the rendered rows while the find bar is open:
// Virtuoso mounts and unmounts rows as the transcript scrolls.
export function useFindHighlights(scroller: HTMLElement | null, find: FindState | undefined) {
  const query = find?.query ?? "";
  const target = find?.target;
  useEffect(() => {
    if (!scroller || !query) { clearHighlights(); return; }
    const pattern = findPattern(query);
    const current = target && { itemId: target.match.itemId, ordinal: target.ordinal };
    let queued = 0;
    const update = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; highlightMatches(scroller, pattern, current); });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(scroller, { subtree: true, childList: true, characterData: true });
    return () => { observer.disconnect(); cancelAnimationFrame(queued); clearHighlights(); };
  }, [scroller, query, target?.seq]);
}

// When a transcript entry happened: HH:MM:SS (local, 24h) in the gutter left
// of the column, shown on hover or keyboard focus. Only real times are shown:
// the entry's own `at` (and a tool's `endedAt`), else tool start/end as this
// client observed them.
import type { Item } from "@casm/protocol";
import type { ToolTime } from "./transcript";
import "./entry-time.css";

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (t: Date) => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
export const fullDate = (t: Date) => `${day.format(t).replace(",", "")}, ${clock(t)}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const shortDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const shortDayYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** "14 Oct" (with the year when it isn't this year's), for entries before today. */
export const dateLabel = (t: Date, now: Date) => (t.getFullYear() === now.getFullYear() ? shortDay : shortDayYear).format(t);
export function took(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${pad(s % 60)}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Start and (for tools) end of an entry, if anything recorded them. */
export function entryTimes(item: Item, tool?: ToolTime): { start: number; end?: number } | undefined {
  const parse = (t?: string) => (t ? Date.parse(t) : NaN);
  const at = parse(item.at);
  const start = Number.isNaN(at) ? tool?.start : at;
  if (start === undefined) return undefined;
  const ended = item.kind === "tool" ? parse(item.endedAt) : NaN;
  const end = Number.isNaN(ended) ? tool?.end : ended;
  return end === undefined ? { start } : { start, end };
}

export function EntryTime({ start, end, inline, now = new Date() }: { start: number; end?: number; inline?: boolean; now?: Date }) {
  const from = new Date(start);
  const label = (t: Date) => (sameDay(t, now) ? clock(t) : fullDate(t));
  const title = end !== undefined
    ? `started ${label(from)} · finished ${label(new Date(end))} · took ${took(end - start)}`
    : sameDay(from, now) ? undefined : fullDate(from);
  // Today: just the time. Earlier: the date too, stacked above it in the gutter.
  return <time className={`entry-time${inline ? " inline" : ""}`} dateTime={from.toISOString()} title={title}>
    {!sameDay(from, now) && <span className="entry-date">{dateLabel(from, now)}</span>}{clock(from)}</time>;
}

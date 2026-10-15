// Entry times: an upserted item keeps the time it was first seen as `at`; a
// tool that leaves "running" gets `endedAt` from the entry that finished it.
import type { Item } from "@casm/protocol";

export type Seen = { at?: string; running?: boolean; endedAt?: string };

/** ISO from milliseconds, seconds-free ISO strings or numbers; else undefined. */
export function isoTime(t: unknown): string | undefined {
  const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

export function timed(prev: Seen | undefined, item: Item, at?: string, endedAt?: string): Item {
  const start = prev?.at ?? item.at ?? at;
  let out: Item = start && item.at !== start ? { ...item, at: start } : item;
  if (out.kind === "tool" && out.status !== "running" && !out.endedAt) {
    const end = endedAt ?? prev?.endedAt ?? (prev?.running ? at : undefined);
    if (end) out = { ...out, endedAt: end };
  }
  return out;
}

export function seen(item: Item): Seen {
  return { at: item.at, running: item.kind === "tool" && item.status === "running", endedAt: item.kind === "tool" ? item.endedAt : undefined };
}

/** A by-id upsert map that stamps times as it goes. */
export class TimedItems {
  readonly byId = new Map<string, Item>();
  put(item: Item, at?: string, endedAt?: string) {
    const prev = this.byId.get(item.id);
    const out = timed(prev && seen(prev), item, at, endedAt);
    this.byId.set(item.id, out);
    return out;
  }
  values() { return [...this.byId.values()]; }
}

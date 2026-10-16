import type { FindMatch, Item } from "@casm/protocol";

// Searched per field: a huge tool output is only searched this far.
const FIELD_CAP = 200_000;
const BEFORE = 40;
const AFTER = 80;

// The searchable text of an item, by field, in the order the web client shows it.
export function itemFields(item: Item): [FindMatch["field"], string][] {
  switch (item.kind) {
    case "user": case "assistant": case "reasoning": case "notice":
      return [["text", item.text]];
    case "tool":
      // As the client shows the input when the row is open.
      return [
        ["input", typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2) ?? ""],
        ["output", item.output ?? ""],
      ];
    case "subagent":
      return [["title", item.title], ["summary", item.summary ?? ""]];
    case "plan":
      return [["text", item.entries.map((e) => e.text).join("\n")]];
  }
}

// Smart case: a query with a capital letter matches case-sensitively.
export function caseSensitive(query: string) {
  return query !== query.toLowerCase();
}

export function findPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), caseSensitive(query) ? "g" : "gi");
}

// Every occurrence of `query` in `items` (whose first one is at `base` in the
// agent's history), oldest first; only the latest `limit` are returned.
export function findInItems(items: Item[], query: string, opts: { limit?: number; kinds?: Item["kind"][]; base?: number } = {}) {
  const limit = opts.limit ?? 500;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
  const pattern = findPattern(query);
  const matches: FindMatch[] = [];
  let total = 0;
  if (!query) return { total, matches };
  items.forEach((item, i) => {
    if (kinds && !kinds.has(item.kind)) return;
    for (const [field, full] of itemFields(item)) {
      const text = full.length > FIELD_CAP ? full.slice(0, FIELD_CAP) : full;
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
        total++;
        const offset = m.index;
        const from = Math.max(0, offset - BEFORE);
        const to = Math.min(text.length, offset + m[0].length + AFTER);
        // Whitespace becomes single spaces one for one, so the offsets hold.
        const snippet = (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s/g, " ") + (to < text.length ? "…" : "");
        const start = offset - from + (from > 0 ? 1 : 0);
        matches.push({
          index: (opts.base ?? 0) + i, itemId: item.id, kind: item.kind, field, offset,
          snippet: { text: snippet, start, end: start + m[0].length },
          ...(item.at ? { at: item.at } : {}),
        });
        if (matches.length >= 2 * limit) matches.splice(0, matches.length - limit);
      }
    }
  });
  return { total, matches: limit ? matches.slice(-limit) : [] };
}

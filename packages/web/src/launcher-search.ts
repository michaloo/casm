export type LauncherGroup = "Agents" | "Projects" | "Actions";
export type SearchEntry = { id: string; group: LauncherGroup; title: string; subtitle: string; attention?: boolean; running?: boolean; activity?: number };
export type Recent = Record<string, number>;
export const recentKey = "casm.launcher.recent";
export const agentRecentKey = (host: string, id: string) => JSON.stringify([host, id]);

export function readRecent(storage: Pick<Storage, "getItem">): Recent {
  try {
    const value = JSON.parse(storage.getItem(recentKey) ?? "{}");
    return Object.fromEntries(Object.entries(value ?? {}).filter(([key, time]) => key.startsWith("[") && typeof time === "number" && Number.isFinite(time)) as [string, number][]);
  } catch { return {}; }
}
export function rememberAgent(storage: Pick<Storage, "getItem" | "setItem">, host: string, id: string, now = Date.now()) {
  const recent = { ...readRecent(storage), [agentRecentKey(host, id)]: now };
  try { storage.setItem(recentKey, JSON.stringify(Object.fromEntries(Object.entries(recent).sort((a, b) => b[1] - a[1]).slice(0, 200)))); } catch { /* Private mode/quota: navigation must still work. */ }
}

/** Subsequence matching, preferring contiguous words and word starts. Positions
 * refer to the original string, so highlighting never interprets user HTML. */
export function fuzzy(text: string, query: string): { score: number; positions: number[] } | null {
  const haystack = text.toLowerCase();
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let score = 0;
  const positions = new Set<number>();
  for (const word of words) {
    let best: { score: number; positions: number[] } | null = null;
    for (let start = haystack.indexOf(word[0]); start >= 0; start = haystack.indexOf(word[0], start + 1)) {
      const found = [start];
      let at = start;
      for (let i = 1; i < word.length; i++) {
        at = haystack.indexOf(word[i], at + 1);
        if (at < 0) break;
        found.push(at);
      }
      if (found.length !== word.length) continue;
      const gaps = found.at(-1)! - start + 1 - word.length;
      const candidate = word.length * 10 + (start === 0 ? 40 : /[^\p{L}\p{N}]/u.test(text[start - 1]) ? 25 : 0) + (gaps === 0 ? 30 : 0) - gaps - start * .05;
      if (!best || candidate > best.score) best = { score: candidate, positions: found };
    }
    if (!best) return null;
    score += best.score;
    best.positions.forEach(position => positions.add(position));
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export function rankEntries<T extends SearchEntry>(entries: T[], query: string, recent: Recent) {
  const searching = !!query.trim();
  const tier = (entry: T) => entry.group !== "Agents" ? 4 : entry.attention ? 0 : entry.running ? 1 : recent[entry.id] ? 2 : 3;
  return entries.flatMap(entry => {
    const match = fuzzy(`${entry.title}\n${entry.subtitle}`, query);
    return match ? [{ entry, ...match }] : [];
  }).sort((a, b) => (searching ? b.score - a.score : tier(a.entry) - tier(b.entry))
    || (recent[b.entry.id] ?? 0) - (recent[a.entry.id] ?? 0)
    || (b.entry.activity ?? 0) - (a.entry.activity ?? 0)
    || a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id));
}

// Estimated cost per agent provider per local day, from what the agents
// recorded in their own session data (provider.costs). Computed on demand: the
// agents' stores are the record, so nothing is kept twice, usage from before
// casm watched (or from turns run outside it) counts, and resumed sessions
// can't be counted twice. Each session's per-day sums are cached by the
// provider's cheap costStamp, so a repeat call reads only what changed.
import type { ProviderCosts, ProviderId, Result } from "@casm/protocol";
import type { Store } from "./db.ts";
import type { CostEntry, Provider, ProviderContext } from "./providers/types.ts";

// The local calendar day of `at`, YYYY-MM-DD.
export function localDate(at: number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The last `days` local days, oldest first, ending today.
export function lastDays(days: number, now = new Date()): string[] {
  return Array.from({ length: days }, (_, i) => localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i), 12)));
}

export function byDay(entries: CostEntry[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const e of entries) sums.set(localDate(e.at), (sums.get(localDate(e.at)) ?? 0) + e.costUsd);
  return sums;
}

// Only provider store identity affects deduplication; unrelated per-agent env
// must not count the same native session twice (notably pi/OpenCode).
function storeScope(provider: ProviderId, context?: ProviderContext): string {
  return provider === "codex" ? context?.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? ""
    : provider === "claude" ? context?.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "" : "";
}

type Cached = { stamp: string; days: Map<string, number> };

export class CostReader {
  private cache = new Map<string, Cached>();
  // Session reads counted for tests (cache hits don't read).
  reads = 0;

  private store: Store;
  private providers: () => Provider[];
  private concurrency: number;

  constructor(store: Store, providers: () => Provider[], concurrency = 4) {
    this.store = store;
    this.providers = providers;
    this.concurrency = concurrency;
  }

  private async session(p: Provider, session: string, cwd: string, context?: ProviderContext): Promise<Map<string, number>> {
    const key = JSON.stringify([p.id, session, storeScope(p.id, context)]);
    const stamp = (await p.costStamp?.(session, cwd, context)) ?? null;
    const hit = this.cache.get(key);
    if (hit && stamp !== null && hit.stamp === stamp) return hit.days;
    this.reads++;
    const days = byDay(await p.costs!(session, cwd, context));
    if (stamp !== null) this.cache.set(key, { stamp, days });
    else this.cache.delete(key);
    return days;
  }

  async costs(days = 7, now = new Date()): Promise<Result<"provider.costs">> {
    const window = lastDays(days, now);
    const inWindow = new Set(window);
    const out: ProviderCosts[] = [];
    for (const p of this.providers()) {
      if (!p.costs) continue;
      // Archived agents and sessions left by /restart spent too.
      const seen = new Set<string>();
      const jobs = this.store.listAgents({ includeArchived: true }).filter((a) => a.provider === p.id).flatMap((a) => [
        ...this.store.pastSessions(a.id).map((s) => ({ session: s.nativeSessionId, context: { env: { ...a.config.env, ...s.context?.env } } })),
        ...(a.nativeSessionId ? [{ session: a.nativeSessionId, context: a.config }] : []),
      ].filter(({ session, context }) => {
        const key = JSON.stringify([session, storeScope(p.id, context)]);
        return !seen.has(key) && seen.add(key);
      }).map(({ session, context }) => ({ agent: a.id, session, cwd: a.cwd, context })));
      const sums = new Map(window.map((d) => [d, 0]));
      const spent = new Set<string>();
      let failed = 0;
      let error: string | undefined;
      await pool(jobs, this.concurrency, async (job) => {
        try {
          for (const [date, cost] of await this.session(p, job.session, job.cwd, job.context)) {
            if (!inWindow.has(date) || cost <= 0) continue;
            sums.set(date, sums.get(date)! + cost);
            spent.add(job.agent);
          }
        } catch (e) {
          failed++;
          error = (e as Error).message;
        }
      });
      const list = window.map((date) => ({ date, costUsd: sums.get(date)! }));
      out.push({
        provider: p.id as ProviderId,
        days: list,
        totalUsd: list.reduce((n, d) => n + d.costUsd, 0),
        agents: spent.size,
        ...(failed ? { error: `${failed} session${failed === 1 ? "" : "s"} unreadable: ${error}` } : {}),
      });
    }
    return { today: window.at(-1)!, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, costs: out };
  }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

// The saved copy the client shows before (or without) a live connection: the
// sidebar and the transcripts of recently opened agents. Storage-agnostic so
// the rules (trimming, LRU, size budget, migrations, ownership) run in Node
// tests; offline-idb.ts stores it in IndexedDB, which works on plain http.
import type { Agent, Item, PendingMessage, Project } from "@casm/protocol";

export const SCHEMA = 1;
export type Limits = {
  // Most recently opened agents whose transcripts are kept.
  chats: number;
  // Last items kept per transcript.
  items: number;
  // Rough budget for every saved transcript together, in characters.
  bytes: number;
  // Longest tool output or tool input string kept.
  output: number;
  // Longest message text kept.
  text: number;
};
export const defaultLimits: Limits = { chats: 50, items: 200, bytes: 50_000_000, output: 8_000, text: 200_000 };

export type CachedHost = { id: string; serverId?: string | null; name: string; projects: Project[]; agents: Agent[] };
export type CachedSidebar = { hosts: CachedHost[]; savedAt: number };
export type CachedChat = { items: Item[]; start: number; pending: PendingMessage[]; savedAt: number };
type Meta = {
  schema: number;
  // Fingerprint of the token the copy was saved with.
  owner: string;
  // Per saved chat key: when it was last opened, and its stored size.
  index: Record<string, { openedAt: number; size: number }>;
};

// A key-value store; values are structured-clone friendly plain data.
export interface Store {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

// Upgrades from schema N to N + 1, keyed by N. A gap or a newer schema (a
// downgraded client) clears the copy instead: it can always be fetched again.
export type Migrations = Record<number, (store: Store) => Promise<void>>;
export const migrations: Migrations = {};

// Not a secret: only tells one token's copy from another's. crypto.subtle
// needs a secure context, which plain-http deployments are not.
export function fingerprint(token: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < token.length; i++) {
    a = Math.imul(a ^ token.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ token.charCodeAt(i), 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters not saved offline`;
}
function clipStrings(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === "string") return clip(value, max);
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => clipStrings(v, max, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max, depth + 1)]));
}
// What is kept of one item: image data dropped (the transcript shows a
// placeholder), huge tool output, input and text truncated.
export function trimItem(item: Item, limits: Limits = defaultLimits): Item {
  const images = (list?: { mediaType: string; data?: string }[]) => list?.map(({ mediaType }) => ({ mediaType }));
  switch (item.kind) {
    case "user":
      return { ...item, text: clip(item.text, limits.text), ...(item.images ? { images: images(item.images) } : {}) };
    case "assistant":
    case "reasoning":
    case "notice":
      return { ...item, text: clip(item.text, limits.text) };
    case "tool":
      return {
        ...item,
        input: clipStrings(item.input, limits.output),
        ...(item.output !== undefined ? { output: clip(item.output, limits.output) } : {}),
        ...(item.images ? { images: images(item.images) } : {}),
      };
    default:
      return item;
  }
}

// A fresh history page merged with what was shown before (a saved copy, or
// older pages loaded earlier): the fresh items win, and earlier items are kept
// only when they line up with the fresh page at the same transcript position,
// so a rewritten history never shows stale or duplicate rows.
export function reconcile(previous: Item[], previousStart: number, fresh: Item[], freshStart: number): { items: Item[]; start: number } {
  const seen = new Set<string>();
  const unique = fresh.filter((i) => !seen.has(i.id) && seen.add(i.id));
  if (!unique.length) return { items: unique, start: freshStart };
  const at = previous.findIndex((i) => i.id === unique[0].id);
  if (at <= 0 || previousStart + at !== freshStart) return { items: unique, start: freshStart };
  const before = previous.slice(0, at).filter((i) => !seen.has(i.id));
  if (before.length !== at) return { items: unique, start: freshStart };
  return { items: [...before, ...unique], start: previousStart };
}

export class OfflineCache {
  private queue: Promise<unknown> = Promise.resolve();
  private store: Store;
  limits: Limits;
  constructor(store: Store, limits: Limits = defaultLimits) {
    this.store = store;
    this.limits = limits;
  }
  // Serializes writes: the index in meta is read-modify-write.
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async meta(): Promise<Meta> {
    return ((await this.store.get("meta")) as Meta | undefined) ?? { schema: SCHEMA, owner: "", index: {} };
  }
  // Opens the copy for this token: another token's copy, or an unreadable
  // schema, is cleared first.
  open(token: string, schema = SCHEMA, steps: Migrations = migrations) {
    return this.run(async () => {
      const owner = fingerprint(token);
      let meta = (await this.store.get("meta")) as Meta | undefined;
      if (meta && meta.owner === owner && meta.schema < schema) {
        try {
          for (let v = meta.schema; v < schema; v++) {
            if (!steps[v]) throw new Error(`No migration from schema ${v}`);
            await steps[v](this.store);
          }
          meta = { ...((await this.store.get("meta")) as Meta), schema };
          await this.store.put("meta", meta);
        } catch {
          meta = undefined;
        }
      }
      if (!meta || meta.owner !== owner || meta.schema !== schema) {
        await this.store.clear();
        await this.store.put("meta", { schema, owner, index: {} } satisfies Meta);
      }
    });
  }
  clear() {
    return this.run(() => this.store.clear());
  }
  sidebar(): Promise<CachedSidebar | undefined> {
    return this.run(async () => (await this.store.get("sidebar")) as CachedSidebar | undefined);
  }
  // A host that failed to answer keeps its previously saved projects and agents.
  saveSidebar(hosts: (CachedHost & { error?: string; loading?: boolean })[], now = Date.now()) {
    return this.run(async () => {
      const previous = new Map(((await this.store.get("sidebar")) as CachedSidebar | undefined)?.hosts.map((h) => [h.id, h]));
      const saved = hosts.flatMap((h): CachedHost[] => {
        if (h.error || h.loading) return previous.has(h.id) ? [previous.get(h.id)!] : [];
        return [{ id: h.id, serverId: h.serverId, name: h.name, projects: h.projects, agents: h.agents }];
      });
      await this.store.put("sidebar", { hosts: saved, savedAt: now } satisfies CachedSidebar);
    });
  }
  // Reading a chat counts as opening it for the LRU order.
  chat(key: string, now = Date.now()): Promise<CachedChat | undefined> {
    return this.run(async () => {
      const value = (await this.store.get(`chat:${key}`)) as CachedChat | undefined;
      const meta = await this.meta();
      if (value && meta.index[key]) {
        meta.index[key].openedAt = now;
        await this.store.put("meta", meta);
      }
      return value;
    });
  }
  saveChat(key: string, chat: { items: Item[]; start: number; pending: PendingMessage[] }, now = Date.now()) {
    return this.run(async () => {
      const kept = chat.items.slice(-this.limits.items);
      const value: CachedChat = {
        items: kept.map((i) => trimItem(i, this.limits)),
        start: chat.start + chat.items.length - kept.length,
        pending: chat.pending.map((p) => ({ ...p, text: clip(p.text, this.limits.text) })),
        savedAt: now,
      };
      const size = JSON.stringify(value).length;
      const meta = await this.meta();
      if (size > this.limits.bytes) return;
      await this.store.put(`chat:${key}`, value);
      meta.index[key] = { openedAt: now, size };
      // Newest first; keep within both the count and the size budget.
      let total = 0;
      const order = Object.entries(meta.index).sort((a, b) => b[1].openedAt - a[1].openedAt);
      for (const [i, [k, entry]] of order.entries()) {
        if (i < this.limits.chats && total + entry.size <= this.limits.bytes) {
          total += entry.size;
          continue;
        }
        delete meta.index[k];
        await this.store.delete(`chat:${k}`);
      }
      await this.store.put("meta", meta);
    });
  }
  // Saved chat keys, most recently opened first.
  async saved(): Promise<string[]> {
    const meta = await this.run(() => this.meta());
    return Object.entries(meta.index).sort((a, b) => b[1].openedAt - a[1].openedAt).map(([k]) => k);
  }
}

// An in-memory store for tests and browsers without IndexedDB.
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.data.get(key)); }
  async put(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { this.data.delete(key); }
  async clear() { this.data.clear(); }
  async keys() { return [...this.data.keys()]; }
}

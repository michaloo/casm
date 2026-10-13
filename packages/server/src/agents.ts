// Live agent state. Everything here is in memory and rebuilt lazily: a session
// is opened on the first send and the status is derived from it.
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEvent,
  Answers,
  Catalog,
  AgentStatus,
  Item,
  NotificationName,
  NotificationParams,
  PermissionRequest,
  ProviderId,
  QuestionRequest,
} from "@casm/protocol";
import type { StoredAgent, Store } from "./db.ts";
import type { PermissionAnswer, Provider, ProviderEvent, ProviderSession } from "./providers/types.ts";

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Everything the agent is blocked on: permission prompts and questions.
type Pending =
  | { kind: "permission"; req: PermissionRequest; resolve: (a: PermissionAnswer) => void; reject: (e: Error) => void }
  | { kind: "question"; req: QuestionRequest; resolve: (a: Answers | null) => void; reject: (e: Error) => void };

const CATALOG_TTL_MS = 10 * 60_000;

type Live = {
  session: ProviderSession | null;
  // Bumped whenever the session is replaced, so late events from an old process are ignored.
  generation: number;
  turnId: string | null;
  // Events of the running turn, for clients that subscribe mid-turn.
  turn: AgentEvent[];
  pending: Map<string, Pending>;
  queue: string[];
  lastReply: string | null;
  statusWaiters: Set<() => void>;
};

export type Notify = <N extends NotificationName>(name: N, params: NotificationParams<N>, agentId?: string) => void;

export class AgentManager {
  private live = new Map<string, Live>();
  private catalogs = new Map<ProviderId, { at: number; catalog: Promise<Catalog> }>();

  private store: Store;
  private providers: Map<ProviderId, Provider>;
  private notify: Notify;

  constructor(store: Store, providers: Map<ProviderId, Provider>, notify: Notify) {
    this.store = store;
    this.providers = providers;
    this.notify = notify;
  }

  providerIds(): ProviderId[] {
    return [...this.providers.keys()];
  }

  status(id: string): AgentStatus {
    const l = this.live.get(id);
    if (!l?.turnId) return "idle";
    return l.pending.size ? "waiting" : "running";
  }

  withStatus(a: StoredAgent): Agent {
    return { ...a, status: this.status(a.id) };
  }

  private provider(id: ProviderId): Provider {
    const p = this.providers.get(id);
    if (!p) throw new RpcError(1003, `provider "${id}" is not available on this host`);
    return p;
  }

  private agent(id: string): StoredAgent {
    const a = this.store.getAgent(id);
    if (!a) throw new RpcError(1001, `agent ${id} not found`);
    return a;
  }

  private liveFor(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { session: null, generation: 0, turnId: null, turn: [], pending: new Map(), queue: [], lastReply: null, statusWaiters: new Set() };
      this.live.set(id, l);
    }
    return l;
  }

  private emit(id: string, event: AgentEvent) {
    const l = this.liveFor(id);
    if (l.turnId) {
      // Deltas are only a preview; drop them once the full item lands.
      if (event.type === "item" && (event.item.kind === "assistant" || event.item.kind === "reasoning"))
        l.turn = l.turn.filter((e) => e.type !== "delta");
      l.turn.push(event);
    }
    this.notify("agent.event", { agentId: id, event }, id);
  }

  private statusChanged(id: string) {
    this.notify("agent.status", { agentId: id, status: this.status(id) });
    const l = this.live.get(id);
    if (l) for (const w of [...l.statusWaiters]) w();
  }

  // --- turns

  send(id: string, text: string, whenBusy: "queue" | "steer" = "queue"): { queued: boolean } {
    const a = this.agent(id);
    if (a.archivedAt) throw new RpcError(1003, "agent is archived");
    const l = this.liveFor(id);
    if (l.turnId) {
      if (whenBusy === "queue") {
        l.queue.push(text);
        return { queued: true };
      }
      const itemId = randomUUID();
      this.emit(id, { type: "item", item: { kind: "user", id: itemId, text } });
      l.session!.send(text, itemId);
      return { queued: false };
    }
    this.startTurn(a, l, text);
    return { queued: false };
  }

  private startTurn(a: StoredAgent, l: Live, text: string) {
    if (!l.session) {
      const gen = ++l.generation;
      l.session = this.provider(a.provider).open({
        cwd: a.cwd,
        config: a.config,
        resumeId: a.nativeSessionId,
        emit: (e) => gen === l.generation && this.onProviderEvent(a.id, l, e),
        askPermission: (req, signal) =>
          gen === l.generation ? this.askPermission(a.id, l, req, signal) : Promise.reject(new Error("session replaced")),
        askQuestion: (req, signal) =>
          gen === l.generation ? this.askQuestion(a.id, l, req, signal) : Promise.reject(new Error("session replaced")),
      });
    }
    l.turnId = randomUUID();
    l.turn = [];
    l.lastReply = null;
    this.emit(a.id, { type: "turnStarted", turnId: l.turnId });
    const itemId = randomUUID();
    this.emit(a.id, { type: "item", item: { kind: "user", id: itemId, text } });
    this.statusChanged(a.id);
    l.session.send(text, itemId);
  }

  private onProviderEvent(id: string, l: Live, e: ProviderEvent) {
    switch (e.type) {
      case "sessionId": {
        const a = this.store.getAgent(id);
        if (a && a.nativeSessionId !== e.id) {
          const updated = this.store.updateAgent(id, { nativeSessionId: e.id })!;
          this.notify("agent.changed", { agent: this.withStatus(updated) });
        }
        return;
      }
      case "item":
        if (e.item.kind === "assistant") l.lastReply = e.item.text;
        this.emit(id, { type: "item", item: e.item });
        return;
      case "delta":
        this.emit(id, { type: "delta", kind: e.kind, text: e.text });
        return;
      case "turnEnded":
        this.endTurn(id, l, e.outcome, e.error);
        return;
      case "closed":
        l.session = null;
        l.generation++;
        if (l.turnId) this.endTurn(id, l, "failed", e.error ?? "agent process exited");
        return;
    }
  }

  private endTurn(id: string, l: Live, outcome: "completed" | "interrupted" | "failed", error?: string) {
    if (!l.turnId) return;
    const turnId = l.turnId;
    for (const p of l.pending.values()) p.reject(new Error("turn ended"));
    l.pending.clear();
    this.emit(id, { type: "turnEnded", turnId, outcome, error });
    l.turnId = null;
    l.turn = [];
    this.statusChanged(id);
    const next = l.queue.shift();
    if (next !== undefined) {
      const a = this.store.getAgent(id);
      if (a && !a.archivedAt) this.startTurn(a, l, next);
    }
  }

  private block<P extends Pending>(id: string, l: Live, pending: Omit<P, "resolve" | "reject">, signal: AbortSignal) {
    type A = Parameters<P["resolve"]>[0];
    const reqId = pending.req.id;
    return new Promise<A>((resolve, reject) => {
      const done = () => {
        l.pending.delete(reqId);
        this.emit(id, pending.kind === "permission" ? { type: "permissionResolved", requestId: reqId } : { type: "questionResolved", requestId: reqId });
        this.statusChanged(id);
      };
      l.pending.set(reqId, {
        ...pending,
        resolve: (a: A) => (done(), resolve(a)),
        reject: (e: Error) => (done(), reject(e)),
      } as Pending);
      signal.addEventListener("abort", () => l.pending.get(reqId)?.reject(new Error("aborted")), { once: true });
      this.emit(
        id,
        pending.kind === "permission"
          ? { type: "permission", request: pending.req as PermissionRequest }
          : { type: "question", request: pending.req as QuestionRequest },
      );
      this.statusChanged(id);
    });
  }

  private askPermission(id: string, l: Live, req: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    return this.block<Extract<Pending, { kind: "permission" }>>(id, l, { kind: "permission", req }, signal);
  }

  private askQuestion(id: string, l: Live, req: QuestionRequest, signal: AbortSignal): Promise<Answers | null> {
    return this.block<Extract<Pending, { kind: "question" }>>(id, l, { kind: "question", req }, signal);
  }

  respondPermission(id: string, requestId: string, answer: PermissionAnswer) {
    const p = this.live.get(id)?.pending.get(requestId);
    if (p?.kind !== "permission") throw new RpcError(1001, "no such pending permission request");
    p.resolve(answer);
  }

  answerQuestion(id: string, requestId: string, answers: Answers | null) {
    const p = this.live.get(id)?.pending.get(requestId);
    if (p?.kind !== "question") throw new RpcError(1001, "no such pending question");
    p.resolve(answers);
  }

  catalog(provider: ProviderId, refresh = false): Promise<Catalog> {
    const cached = this.catalogs.get(provider);
    if (cached && !refresh && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
    const catalog = this.provider(provider).catalog();
    this.catalogs.set(provider, { at: Date.now(), catalog });
    catalog.catch(() => this.catalogs.delete(provider));
    return catalog;
  }

  async interrupt(id: string) {
    const l = this.live.get(id);
    if (!l?.turnId || !l.session) return;
    l.queue = [];
    // Cancel open prompts first: an agent can't stop a tool that waits on one.
    for (const p of [...l.pending.values()]) p.reject(new Error("interrupted"));
    await l.session.interrupt();
  }

  // Drops the process; the next send resumes the same native session.
  async reload(id: string) {
    this.agent(id);
    const l = this.live.get(id);
    if (!l) return;
    l.queue = [];
    const s = l.session;
    l.session = null;
    l.generation++;
    if (l.turnId) this.endTurn(id, l, "interrupted");
    await s?.close();
  }

  // Like reload, but the next send starts a new native session.
  async restart(id: string) {
    await this.reload(id);
    const updated = this.store.updateAgent(id, { nativeSessionId: null })!;
    this.notify("agent.changed", { agent: this.withStatus(updated) });
  }

  async remove(id: string) {
    await this.reload(id).catch(() => {});
    this.live.delete(id);
  }

  subscribeState(id: string) {
    this.agent(id);
    const l = this.live.get(id);
    return {
      status: this.status(id),
      turn: l?.turn ?? [],
      permissions: l ? [...l.pending.values()].flatMap((p) => (p.kind === "permission" ? [p.req] : [])) : [],
      questions: l ? [...l.pending.values()].flatMap((p) => (p.kind === "question" ? [p.req] : [])) : [],
    };
  }

  async history(id: string, before?: number, limit = 200): Promise<{ items: Item[]; start: number; total: number }> {
    const a = this.agent(id);
    if (!a.nativeSessionId) return { items: [], start: 0, total: 0 };
    const all = await this.provider(a.provider).history(a.nativeSessionId, a.cwd);
    const end = Math.min(before ?? all.length, all.length);
    const start = Math.max(0, end - limit);
    return { items: all.slice(start, end), start, total: all.length };
  }

  async wait(id: string, timeoutMs = 10 * 60_000) {
    this.agent(id);
    const l = this.liveFor(id);
    let timedOut = false;
    if (this.status(id) === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => ((timedOut = true), finish()), timeoutMs);
        const check = () => this.status(id) !== "running" && finish();
        const finish = () => {
          clearTimeout(timer);
          l.statusWaiters.delete(check);
          resolve();
        };
        l.statusWaiters.add(check);
      });
    }
    let lastReply = l.lastReply;
    if (lastReply === null && this.status(id) === "idle") {
      const { items } = await this.history(id, undefined, 50);
      lastReply = items.findLast((i) => i.kind === "assistant")?.text ?? null;
    }
    return { status: this.status(id), timedOut, lastReply };
  }

  async shutdown() {
    await Promise.all([...this.live.values()].map((l) => l.session?.close().catch(() => {})));
  }
}

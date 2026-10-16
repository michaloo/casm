// Live agent state. Everything here is in memory and rebuilt lazily: a session
// is opened on the first send and the status is derived from it.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
  Agent,
  AgentConfig,
  AgentEvent,
  Answers,
  Catalog,
  Command,
  ImageData,
  AgentStatus,
  Item,
  NotificationName,
  NotificationParams,
  PermissionRequest,
  ProviderId,
  PendingMessage,
  MessageSender,
  ProviderLimits,
  QuestionRequest,
  SubagentInfo,
  SubagentItem,
  Usage,
} from "@casm/protocol";
import type { StoredAgent, Store } from "./db.ts";
import type { PermissionAnswer, Provider, ProviderEvent, ProviderSession } from "./providers/types.ts";
import { AgentPrompt, type PromptVars } from "./agent-prompt.ts";
import { limitFromText, mergeWindows, retryAt, transientRateLimit, type LimitHit } from "./limits.ts";
import { seen, timed, type Seen } from "./item-times.ts";

// What sessions are told about the server that runs them.
export type SessionContext = { serverId: string; serverName: string };

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// The provider threw while taking a prompt; the turn has ended and kept the
// prompt as failed already, so callers must not put it back again.
class DispatchFailed extends RpcError {}

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
  // Config changed mid-turn: restart the process once the turn ends.
  reloadAfterTurn: boolean;
  lastReply: string | null;
  lastUsage: Usage | null;
  // The prompt that started the running turn, kept to retry it after a limit.
  prompt: Prompt | null;
  // Events this turn that show the agent responding, and the prompts steered
  // into it with the count at the time: one with no response after it may never
  // have reached the agent's own history.
  answers: number;
  steered: { prompt: Prompt; answersAt: number }[];
  // When the running turn started, to tell fresh limit reports from old ones.
  turnStartedAt: number;
  lastTurn: { outcome: "completed" | "interrupted" | "failed"; error?: string; kept?: string[] } | null;
  // Ids of the latest prompts handed to the session, so a resent agent.send
  // (same messageId) is not delivered twice.
  delivered: string[];
  statusWaiters: Set<() => void>;
  // When each live item was first seen (and a tool finished), so upserts keep it.
  times: Map<string, Seen>;
  // Subagent items the provider reported since the server started, by id, kept
  // across turns: background ones finish while the agent is idle.
  subagents: Map<string, Tracked>;
};

// The latest subagent item and when it was seen. `stale`: it was running when
// its session ended, so it will never report finishing.
type Tracked = { item: SubagentItem; startedAt: string; updatedAt: string; stale?: boolean };

// Finished subagents kept per agent for agent.subagents.
const KEEP_FINISHED = 50;

// id: the user item's id. A delivered pending message keeps its pending id, so
// clients can match the bubble they showed as pending to the item that lands.
export type Prompt = { text: string; images?: ImageData[]; id?: string; sender?: MessageSender };

export type Notify = <N extends NotificationName>(name: N, params: NotificationParams<N>, agentId?: string) => void;

export class AgentManager {
  private commandCache = new Map<string, { at: number; pending: boolean; promise: Promise<Command[]> }>();
  private live = new Map<string, Live>();
  private catalogs = new Map<ProviderId, { at: number; catalog: Promise<Catalog> }>();
  // Latest account limits per provider, as sessions or queries reported them.
  private limitsSeen = new Map<ProviderId, ProviderLimits>();
  private limitsQueried = new Set<ProviderId>();
  private context: SessionContext | null = null;
  // Set by shutdown: late events from closing sessions must not touch the closed store.
  private stopped = false;

  private store: Store;
  private providers: Map<ProviderId, Provider>;
  private notify: Notify;

  private deferTimer: ReturnType<typeof setInterval>;
  // Retries already made for an agent's deferred prompt, for backoff.
  private retryAttempts = new Map<string, number>();

  readonly agentPrompt: AgentPrompt;

  constructor(store: Store, providers: Map<ProviderId, Provider>, notify: Notify, agentPrompt = new AgentPrompt(null)) {
    this.store = store;
    this.providers = providers;
    this.notify = notify;
    this.agentPrompt = agentPrompt;
    for (const limits of store.providerAvailability()) this.limitsSeen.set(limits.provider, limits);
    // Upgrade older stores conservatively: their pending limit rows are the
    // only persisted evidence of a provider gate. Never overwrite a recorded
    // recovery with a stale pending row.
    const legacy = new Map<ProviderId, number>();
    for (const pending of store.listPending()) {
      if (pending.reason !== "limit" || !pending.notBefore) continue;
      const provider = store.getAgent(pending.agentId)?.provider;
      const until = Date.parse(pending.notBefore);
      if (!provider || this.limitsSeen.has(provider) || !(until > Date.now())) continue;
      legacy.set(provider, Math.max(legacy.get(provider) ?? 0, until));
    }
    for (const [provider, until] of legacy) {
      const limits: ProviderLimits = { provider, updatedAt: new Date().toISOString(),
        windows: [{ id: "limit", label: "usage limit", status: "exhausted", resetsAt: new Date(until).toISOString() }] };
      store.saveProviderAvailability(limits);
      this.limitsSeen.set(provider, limits);
    }
    // Pending messages survive restarts; send due ones every 15 s.
    this.deferTimer = setInterval(() => this.runDuePending(), 15_000);
    this.deferTimer.unref();
  }

  setContext(ctx: SessionContext) {
    this.context = ctx;
  }

  messageSender(id: string): MessageSender {
    return { serverId: this.context?.serverId ?? this.store.serverId(), agentId: id, name: this.agent(id).name, host: this.context?.serverName };
  }

  scheduleSender(id: string, name: string): MessageSender {
    return { serverId: this.context?.serverId ?? this.store.serverId(), agentId: `schedule:${id}`, name, host: this.context?.serverName, schedule: { id, name } };
  }

  // The stored config plus what the server adds to every session: CASM_* env
  // vars (so `casm run` and `casm send` from inside link and attribute to it)
  // and the host's agent prompt ahead of the agent's own.
  private sessionConfig(a: StoredAgent): AgentConfig {
    const ctx = this.context;
    if (!ctx) return a.config;
    const env = { ...a.config.env, CASM_SERVER_ID: ctx.serverId, CASM_SERVER_NAME: ctx.serverName, CASM_AGENT_ID: a.id, CASM_AGENT_NAME: a.name };
    const hostPrompt = this.agentPrompt.render(this.promptVars(a));
    const systemPrompt = [hostPrompt, a.config.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    return { ...a.config, env, systemPrompt };
  }

  // What the agent prompt's placeholders stand for, for this agent.
  promptVars(a: Pick<StoredAgent, "id" | "name" | "projectId" | "cwd" | "provider">): PromptVars {
    return {
      host: this.context?.serverName ?? "",
      agentId: a.id,
      agentName: a.name,
      project: this.store.getProject(a.projectId)?.name ?? a.projectId,
      cwd: a.cwd,
      provider: a.provider,
    };
  }

  providerIds(): ProviderId[] {
    return [...this.providers.keys()];
  }

  installedProviders(): Provider[] {
    return [...this.providers.values()];
  }

  runningCount(): number {
    let n = 0;
    for (const l of this.live.values()) if (l.turnId) n++;
    return n;
  }

  status(id: string): AgentStatus {
    const l = this.live.get(id);
    if (!l?.turnId) return "idle";
    return l.pending.size ? "waiting" : "running";
  }

  withStatus(a: StoredAgent): Agent {
    const pending = this.store.listPending(a.id);
    const limit = pending.find((m) => m.reason === "limit" && m.notBefore);
    const times = pending.flatMap((m) => (m.notBefore ? [m.notBefore] : [])).sort();
    return {
      ...a,
      status: this.status(a.id),
      deferred: limit ? { until: limit.notBefore!, reason: limit.note ?? "usage limit" } : null,
      pending: {
        count: pending.length, ...(times[0] ? { next: times[0] } : {}),
        ...(pending[0]?.reason === "failed" || pending[0]?.reason === "limit"
          ? { held: { reason: pending[0].reason, ...(pending[0].note ? { note: pending[0].note } : {}) } } : {}),
      },
      subagents: { running: this.runningSubagents(a.id) },
    };
  }

  private runningSubagents(id: string): number {
    let n = 0;
    for (const t of this.live.get(id)?.subagents.values() ?? []) if (t.item.status === "running" && !t.stale) n++;
    return n;
  }

  // Upserts a subagent item; tells clients when the running count changes.
  private trackSubagent(id: string, l: Live, item: SubagentItem) {
    const before = this.runningSubagents(id);
    const now = new Date().toISOString();
    const prev = l.subagents.get(item.id);
    l.subagents.delete(item.id);
    l.subagents.set(item.id, { item, startedAt: prev?.startedAt ?? now, updatedAt: now });
    const finished = [...l.subagents.values()].filter((t) => t.item.status !== "running" || t.stale);
    for (const t of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) l.subagents.delete(t.item.id);
    if (this.runningSubagents(id) !== before) this.changed(id);
  }

  // The session is gone: what it was still running can't report back.
  private sessionEnded(id: string, l: Live) {
    let n = 0;
    for (const t of l.subagents.values()) if (t.item.status === "running" && !t.stale) (t.stale = true), n++;
    if (n) this.changed(id);
  }

  async subagents(id?: string, limit = 10): Promise<SubagentInfo[]> {
    const info = (agentId: string, t: Tracked): SubagentInfo => {
      const { kind: _, ...item } = t.item;
      return { agentId, ...item, startedAt: t.startedAt, updatedAt: t.updatedAt, ...(t.stale ? { stale: true } : {}) };
    };
    const ids = id ? [this.agent(id).id] : [...this.live.keys()];
    const out: SubagentInfo[] = [];
    for (const agentId of ids) {
      const l = this.live.get(agentId);
      const list = [...(l?.subagents.values() ?? [])].map((t) => info(agentId, t));
      if (id) {
        // The transcript knows the ones from before this server started. One it
        // records as running ran in a process that is gone: sessions don't
        // survive a server restart, and this server would have seen it otherwise.
        const seen = new Set(list.map((x) => x.id));
        const items = await this.currentHistory(agentId).catch(() => []);
        const latest = new Map<string, SubagentItem>();
        for (const i of items) if (i.kind === "subagent" && !seen.has(i.id)) latest.set(i.id, i);
        const older = [...latest.values()].reverse().map(({ kind: _, ...i }): SubagentInfo => ({
          agentId,
          ...i,
          ...(i.status === "running" ? { stale: true } : {}),
        }));
        list.push(...older);
      }
      const running = list.filter((x) => x.status === "running" && !x.stale);
      const rest = list.filter((x) => !(x.status === "running" && !x.stale));
      // Most recent first; transcript-only entries keep their order after the tracked ones.
      rest.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      running.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      out.push(...running, ...rest.slice(0, limit));
    }
    return out;
  }

  private changed(id: string) {
    const a = this.store.getAgent(id);
    if (a) this.notify("agent.changed", { agent: this.withStatus(a) });
  }

  pendingMessages(agentId?: string): PendingMessage[] {
    return this.store.listPending(agentId).map((m) => ({
      id: m.id,
      agentId: m.agentId,
      text: m.text,
      ...(m.sender ? { sender: m.sender } : {}),
      ...(m.images?.length ? { imageCount: m.images.length } : {}),
      reason: m.reason,
      ...(m.notBefore ? { notBefore: m.notBefore } : {}),
      ...(m.note ? { note: m.note } : {}),
      createdAt: m.createdAt,
    }));
  }

  cancelPending(id: string, messageId?: string): number {
    this.agent(id);
    const n = messageId
      ? this.store.listPending(id).some((m) => m.id === messageId) && this.store.removePending(messageId)
        ? 1
        : 0
      : this.store.clearPending(id);
    if (messageId && !n) throw new RpcError(1001, "no such pending message");
    if (n) {
      // The one it removed may have been holding the queue.
      this.runNext(id);
      this.changed(id);
    }
    return n;
  }

  editPending(id: string, messageId: string, text: string) {
    this.agent(id);
    const m = this.store.getPending(messageId);
    if (m?.agentId !== id) throw new RpcError(1001, "no such pending message (it may have been sent or cancelled already)");
    if (!text.trim() && !m.images?.length) throw new RpcError(-32602, "nothing to send");
    this.store.editPending(messageId, text);
    this.changed(id);
  }

  // "Retry now" for a message held back by a failure or a limit: one attempt
  // right away when the agent is idle, past any limit; while it is busy the
  // message just stops holding the queue and goes after the running turn.
  retryPending(id: string, messageId: string) {
    this.agent(id);
    const m = this.store.listPending(id).find((x) => x.id === messageId);
    if (!m) throw new RpcError(1001, "no such pending message (it may have been sent or cancelled already)");
    if (!this.live.get(id)?.turnId) return this.resend(id, m, "queue", true);
    this.store.requeuePending(m.id);
    this.changed(id);
    return { queued: true, pendingId: m.id };
  }

  // Sends a pending message right away, its images included: into the running
  // turn, or as a new turn when the agent is idle.
  steerPending(id: string, messageId: string) {
    this.agent(id);
    const m = this.store.listPending(id).find((x) => x.id === messageId);
    if (!m) throw new RpcError(1001, "no such pending message (it may have been sent or cancelled already)");
    return this.resend(id, m, "steer", true);
  }

  // Takes a pending message out and sends it; if that throws, it is kept again
  // where it was, with the same id.
  private resend(id: string, m: ReturnType<Store["listPending"]>[number], whenBusy: "queue" | "steer", retryLimited = false) {
    this.store.removePending(m.id);
    try {
      return this.send(id, { text: m.text, images: m.images, id: m.id, sender: m.sender }, whenBusy, "queue", retryLimited);
    } catch (e) {
      // A turn that started and failed has kept it as failed already: back
      // where it was. Anything else puts it back as it was.
      const kept = e instanceof DispatchFailed ? this.live.get(id)?.lastTurn?.kept?.at(-1) : undefined;
      if (kept) this.store.movePending(kept, m.seq);
      else if (!(e instanceof DispatchFailed)) this.store.movePending(this.store.addPending(m).id, m.seq);
      throw e;
    } finally {
      this.changed(id);
    }
  }

  blocked() {
    return [...this.live.entries()].flatMap(([agentId, l]) => {
      const kinds = [...l.pending.values()];
      const permissions = kinds.filter((p) => p.kind === "permission").length;
      const questions = kinds.length - permissions;
      return kinds.length ? [{ agentId, permissions, questions }] : [];
    });
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
      l = { session: null, generation: 0, turnId: null, turn: [], pending: new Map(), reloadAfterTurn: false, lastReply: null, lastUsage: null, prompt: null, turnStartedAt: 0, lastTurn: null, answers: 0, steered: [], delivered: [], statusWaiters: new Set(), subagents: new Map(), times: new Map() };
      this.live.set(id, l);
    }
    return l;
  }

  private emit(id: string, event: AgentEvent) {
    const l = this.liveFor(id);
    if (event.type === "item") {
      const now = new Date().toISOString();
      const item = timed(l.times.get(event.item.id), event.item, now);
      // Bounded: only the newest items can still be upserted.
      if (l.times.size >= 2000) l.times.delete(l.times.keys().next().value!);
      l.times.delete(item.id);
      l.times.set(item.id, seen(item));
      event = { ...event, item };
    }
    if (l.turnId) {
      // Usage isn't an answer: Claude reports it on system/init, before replying.
      if ((event.type === "item" && event.item.kind !== "user" && event.item.kind !== "notice") || event.type === "delta" || event.type === "toolOutput")
        l.answers++;
      // Deltas are only a preview; drop them once the full item lands.
      if (event.type === "item" && (event.item.kind === "assistant" || event.item.kind === "reasoning"))
        l.turn = l.turn.filter((e) => e.type !== "delta");
      // Streamed tool output is superseded by the finished tool item.
      if (event.type === "item" && event.item.kind === "tool" && event.item.status !== "running") {
        const done = event.item.id;
        l.turn = l.turn.filter((e) => e.type !== "toolOutput" || e.itemId !== done);
      }
      l.turn.push(event);
    }
    this.notify("agent.event", { agentId: id, event }, id);
  }

  // Who sent the prompt that started the agent's running turn.
  turnSender(id: string): MessageSender | undefined {
    const l = this.live.get(id);
    return l?.turnId ? l.prompt?.sender : undefined;
  }

  private statusChanged(id: string) {
    this.notify("agent.status", { agentId: id, status: this.status(id) });
    const l = this.live.get(id);
    if (l) for (const w of [...l.statusWaiters]) w();
  }

  // --- turns

  send(
    id: string,
    prompt: Prompt,
    whenBusy: "queue" | "steer" = "queue",
    whenLimited: "queue" | "fail" = "queue",
    retryLimited = false,
  ): { queued: boolean; deferredUntil?: string; pendingId?: string } {
    const a = this.agent(id);
    if (a.archivedAt) throw new RpcError(1003, "agent is archived");
    if (!prompt.text.trim() && !prompt.images?.length) throw new RpcError(-32602, "nothing to send");
    const l = this.liveFor(id);
    if (prompt.id) {
      // The same message again: report what happened to it the first time.
      const known = this.store.getPending(prompt.id);
      if (known && known.agentId !== id) throw new RpcError(1003, "message id already used");
      if (known) return { queued: true, pendingId: known.id, ...(known.notBefore ? { deferredUntil: known.notBefore } : {}) };
      if (l.delivered.includes(prompt.id)) return { queued: false };
    }
    // Explicit steering belongs to the existing turn, not admission of a new one.
    // Cached account limits must not prevent delivery; a provider rejection still
    // follows the normal turn failure/limit path and preserves unanswered prompts.
    if (l.turnId && whenBusy === "steer") {
      l.steered.push({ prompt, answersAt: l.answers });
      this.sendToSession(id, l, prompt);
      return { queued: false };
    }
    // A message already waiting on a limit, or the provider known to be over it: wait too.
    const waiting = this.store.listPending(id).find((m) => m.reason === "limit");
    const blocked = waiting ? null : this.exhaustedUntil(a.provider);
    if (!retryLimited && (waiting || blocked)) {
      const reason = waiting?.note ?? `${a.provider} is over its usage limit`;
      const until = waiting?.notBefore ?? blocked!;
      if (whenLimited === "fail") throw new RpcError(1004, `${reason}; resets ${until}`);
      const m = this.store.addPending({ agentId: id, ...prompt, reason: waiting ? "queued" : "limit", notBefore: waiting ? null : until, note: waiting ? null : reason });
      this.changed(id);
      return { queued: true, deferredUntil: until, pendingId: m.id };
    }
    // Busy, or idle with older messages still waiting (a restart, a failed
    // start): behind them. Only steering and "Send now" go ahead of the queue.
    const backlog = !retryLimited && this.store.listPending(id).length > 0;
    if (l.turnId || backlog) {
      const m = this.store.addPending({ agentId: id, ...prompt, reason: "queued", notBefore: null, note: null });
      if (!l.turnId) this.runNext(id);
      this.changed(id);
      return this.store.getPending(m.id) ? { queued: true, pendingId: m.id } : { queued: false };
    }
    this.startTurn(a, l, prompt);
    return { queued: false };
  }

  shell(id: string, command: string) {
    const a = this.agent(id);
    if (a.archivedAt) throw new RpcError(1003, "agent is archived");
    const l = this.liveFor(id);
    if (l.turnId) throw new RpcError(1002, "the agent is busy; run the command when it is idle");
    this.openSession(a, l);
    l.turnId = randomUUID();
    l.turn = [];
    l.answers = 0;
    l.steered = [];
    l.lastReply = null;
    this.emit(id, { type: "turnStarted", turnId: l.turnId });
    this.statusChanged(id);
    this.guard(id, l, () => l.session!.shell(command, randomUUID(), l.turnId!));
  }

  // A provider that throws while starting work must not leave the agent "running".
  private guard(id: string, l: Live, start: () => void) {
    const turnId = l.turnId;
    try {
      start();
    } catch (e) {
      if (!l.turnId) throw new RpcError(-32603, e instanceof Error ? e.message : String(e));
      if (l.turnId === turnId) this.endTurn(id, l, "failed", e instanceof Error ? e.message : String(e));
      throw new DispatchFailed(-32603, e instanceof Error ? e.message : String(e));
    }
  }

  private sendToSession(id: string, l: Live, prompt: Prompt) {
    const itemId = prompt.id ??= randomUUID();
    if (prompt.sender) this.store.saveMessageSender(id, itemId, prompt.sender);
    const images = prompt.images?.length ? prompt.images : undefined;
    this.emit(id, { type: "item", item: { kind: "user", id: itemId, text: prompt.text, images, ...(prompt.sender ? { sender: prompt.sender } : {}) } });
    this.guard(id, l, () => l.session!.send(prompt.text, itemId, images, l.turnId!));
    l.delivered = [...l.delivered.slice(-99), itemId];
  }

  private startTurn(a: StoredAgent, l: Live, prompt: Prompt) {
    this.openSession(a, l);
    l.turnId = randomUUID();
    l.turn = [];
    l.answers = 0;
    l.steered = [];
    l.lastReply = null;
    l.prompt = prompt;
    l.turnStartedAt = Date.now();
    this.emit(a.id, { type: "turnStarted", turnId: l.turnId });
    this.statusChanged(a.id);
    this.sendToSession(a.id, l, prompt);
  }

  private openSession(a: StoredAgent, l: Live) {
    if (!l.session) {
      // Providers fail asynchronously (and silently) in a missing cwd; refuse up front.
      if (!statSync(a.cwd, { throwIfNoEntry: false })?.isDirectory())
        throw new RpcError(-32602, `the agent's folder does not exist on this host: ${a.cwd}`);
      void this.commands(a.id).catch(() => {});
      const gen = ++l.generation;
      l.session = this.provider(a.provider).open({
        cwd: a.cwd,
        config: this.sessionConfig(a),
        resumeId: a.nativeSessionId,
        emit: (e) => gen === l.generation && !this.stopped && this.onProviderEvent(a.id, l, e),
        askPermission: (req, signal) =>
          gen === l.generation ? this.askPermission(a.id, l, req, signal) : Promise.reject(new Error("session replaced")),
        askQuestion: (req, signal) =>
          gen === l.generation ? this.askQuestion(a.id, l, req, signal) : Promise.reject(new Error("session replaced")),
      });
    }
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
      case "model": {
        // A session due for reload runs the old config; its model is no longer the agent's.
        if (l.reloadAfterTurn) return;
        const a = this.store.getAgent(id);
        if (a && a.effectiveModel !== e.model) {
          const updated = this.store.updateAgent(id, { effectiveModel: e.model })!;
          this.notify("agent.changed", { agent: this.withStatus(updated) });
        }
        return;
      }
      case "mode": {
        // A pending config change (reloadAfterTurn) decides the mode of the next session.
        if (l.reloadAfterTurn) return;
        const a = this.store.getAgent(id);
        if (a && (a.config.mode ?? "default") !== e.mode) {
          const updated = this.store.updateAgent(id, { config: { ...a.config, mode: e.mode } })!;
          this.notify("agent.changed", { agent: this.withStatus(updated) });
        }
        return;
      }
      case "userMessageId": {
        const sender = this.store.messageSender(id, e.itemId);
        if (sender) this.store.saveMessageSender(id, e.nativeId, sender);
        return;
      }
      case "item":
        if (e.item.kind === "user") {
          const sender = this.store.messageSender(id, e.item.id);
          if (sender) e.item = { ...e.item, sender };
        }
        if (e.item.kind === "assistant") l.lastReply = e.item.text;
        this.emit(id, { type: "item", item: e.item });
        if (e.item.kind === "subagent") this.trackSubagent(id, l, e.item);
        return;
      case "delta":
        this.emit(id, { type: "delta", kind: e.kind, text: e.text });
        return;
      case "toolOutput":
        this.emit(id, { type: "toolOutput", itemId: e.itemId, text: e.text });
        return;
      case "limits": {
        const a = this.store.getAgent(id);
        if (a) this.recordLimits(a.provider, e.limits);
        return;
      }
      case "usage":
        l.lastUsage = { ...l.lastUsage, ...e.usage };
        this.emit(id, { type: "usage", usage: l.lastUsage });
        return;
      case "turnEnded":
        if (e.turnId !== undefined && e.turnId !== l.turnId) return;
        if (e.recycleSession) l.reloadAfterTurn = true;
        this.endTurn(id, l, e.outcome, e.error, e.outcome === "failed" ? this.limitHit(id, l, e.error) : null);
        return;
      case "closed":
        l.session = null;
        l.generation++;
        if (l.turnId) this.endTurn(id, l, "failed", e.error ?? "agent process exited");
        this.sessionEnded(id, l);
        return;
    }
  }

  private endTurn(
    id: string,
    l: Live,
    outcome: "completed" | "interrupted" | "failed",
    error?: string,
    limit: LimitHit | null = null,
  ) {
    if (!l.turnId) return;
    const turnId = l.turnId;
    l.lastTurn = { outcome, ...(error ? { error } : {}) };
    for (const p of l.pending.values()) p.reject(new Error("turn ended"));
    l.pending.clear();
    this.emit(id, { type: "turnEnded", turnId, outcome, error, limit: limit ?? undefined });
    l.turnId = null;
    l.turn = [];
    if (l.reloadAfterTurn) this.dropSession(id, l);
    const a = this.store.getAgent(id);
    if (limit && a && l.prompt) {
      // Retry the prompt that hit the limit first, then those steered in that
      // got no answer; anything queued waits behind them.
      const attempts = this.retryAttempts.get(id) ?? 0;
      const prompt = l.prompt;
      l.prompt = null;
      const kept = this.keepUnanswered(id, l, limit.message, { reason: "limit", notBefore: retryAt(limit, attempts).toISOString(), attempts });
      // A new id: the provider may have recorded the attempt under the old one.
      this.store.addPending({ agentId: id, ...prompt, id: undefined, reason: "limit", notBefore: retryAt(limit, attempts).toISOString(), note: limit.message, attempts, front: true });
      if (kept.length) l.lastTurn.kept = kept;
      this.changed(id);
    } else if (outcome === "failed" && a) {
      // Kept where the user can see, retry or cancel them, instead of vanishing.
      const kept = this.keepUnanswered(id, l, error ?? "the turn failed");
      if (kept.length) {
        l.lastTurn.kept = kept;
        this.changed(id);
      }
    }
    l.prompt = null;
    l.steered = [];
    this.statusChanged(id);
    if (limit) return;
    this.retryAttempts.delete(id);
    // A turn that went through means the limit has lifted, whatever was announced.
    if (outcome === "completed" && a) {
      const seen = this.limitsSeen.get(a.provider);
      const blocked = seen?.windows.filter((w) => w.status === "exhausted") ?? [];
      if (blocked.length) this.recordLimits(a.provider, { windows: blocked.map((w) => ({ ...w, status: "ok" as const })) });
      this.store.releaseLimited(id);
    }
    this.runNext(id);
  }

  // Keeps the turn's prompts nothing came back for (the one that started it and
  // any steered in later) as failed pending messages, in order, ahead of the
  // queue: they were sent before it, and hold it until retried or cancelled.
  // Returns their ids.
  private keepUnanswered(
    id: string,
    l: Live,
    note: string,
    as: { reason: "failed" | "limit"; notBefore: string | null; attempts?: number } = { reason: "failed", notBefore: null },
  ): string[] {
    const prompts = [...(l.prompt && !l.answers ? [l.prompt] : []), ...l.steered.filter((s) => s.answersAt === l.answers).map((s) => s.prompt)];
    // New ids: the agent may have recorded them under the old ones.
    const ids = prompts
      .reverse()
      .map((p) => this.store.addPending({ agentId: id, ...p, id: undefined, ...as, note, front: true }).id)
      .reverse();
    l.prompt = null;
    l.steered = [];
    return ids;
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
      pending.req.at ??= new Date().toISOString();
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

  // Stops the running turn; the queue stays and goes on after it.
  async interrupt(id: string) {
    const l = this.live.get(id);
    if (!l?.turnId || !l.session) return;
    // Cancel open prompts first: an agent can't stop a tool that waits on one.
    for (const p of [...l.pending.values()]) p.reject(new Error("interrupted"));
    await l.session.interrupt();
  }

  private dropSession(id: string, l: Live) {
    l.reloadAfterTurn = false;
    const s = l.session;
    l.session = null;
    l.generation++;
    void s?.close().catch(() => {});
    this.sessionEnded(id, l);
  }

  // A new config applies when the session is next opened: now if idle,
  // otherwise after the running turn.
  configChanged(id: string) {
    const l = this.live.get(id);
    if (!l?.session) return;
    if (l.turnId) l.reloadAfterTurn = true;
    else this.dropSession(id, l);
  }

  private mcpSession(id: string) {
    const a = this.agent(id);
    if (a.archivedAt) throw new RpcError(1003, "agent is archived");
    const l = this.liveFor(id);
    this.openSession(a, l);
    return l.session!;
  }

  async mcpStatus(id: string): Promise<import("@casm/protocol").McpStatus> {
    const session = this.mcpSession(id);
    if (!session.mcpStatus) return { servers: [], reconnect: "reload", canToggle: false, message: "This provider has no native MCP status API. Reconnect reloads the agent session to re-read configuration." };
    try {
      return { servers: await session.mcpStatus(), reconnect: session.mcpReconnect ? session.mcpReconnectScope ?? "server" : "reload", canToggle: !!session.mcpToggle };
    } catch (e) {
      if ((e as { code?: number }).code !== -32601) throw e;
      return { servers: [], reconnect: "reload", canToggle: false, message: "This provider version has no native MCP status API. Reconnect falls back to reloading the session if native reload is unavailable." };
    }
  }

  async mcpReconnect(id: string, server?: string): Promise<import("@casm/protocol").McpAction> {
    const session = this.mcpSession(id);
    if (session.mcpReconnect) {
      try { return { mode: "native", message: await session.mcpReconnect(server) }; }
      catch (e) { if ((e as { code?: number }).code !== -32601) throw e; }
    }
    await this.reload(id);
    this.mcpSession(id);
    return { mode: "reload", message: "Provider has no native MCP reconnect API; reloaded the whole agent session to re-read MCP configuration." };
  }

  async mcpToggle(id: string, server: string, enabled: boolean): Promise<import("@casm/protocol").McpAction> {
    const session = this.mcpSession(id);
    if (!session.mcpToggle) throw new RpcError(-32602, "This provider does not support toggling MCP servers.");
    await session.mcpToggle(server, enabled);
    return { mode: "native", message: `${server} ${enabled ? "enabled" : "disabled"}.` };
  }

  // Drops the process; the next send resumes the same native session.
  async reload(id: string) {
    this.agent(id);
    const l = this.live.get(id);
    if (!l) return;
    const s = l.session;
    l.session = null;
    l.generation++;
    if (l.turnId) this.endTurn(id, l, "interrupted");
    this.sessionEnded(id, l);
    await s?.close();
  }

  // Like reload, but the next send starts a new native session. The old one
  // stays in the history, before a divider.
  async restart(id: string) {
    await this.reload(id);
    const a = this.agent(id);
    if (a.nativeSessionId) this.store.addPastSession(id, a.nativeSessionId);
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

  // --- usage limits: detection, deferral, retry

  // The turn failed on a limit if the provider said so structurally during the
  // turn (an exhausted window) or the error text says so.
  private limitHit(id: string, l: Live, error?: string): LimitHit | null {
    const a = this.store.getAgent(id);
    // Error notices often carry the reset time the final error text lacks.
    const hits = [
      error,
      ...l.turn.flatMap((e) => (e.type === "item" && e.item.kind === "notice" && e.item.level === "error" ? [e.item.text] : [])),
    ].flatMap((t) => limitFromText(t) ?? []);
    const fromText = hits.find((h) => h.resetsAt) ?? hits[0] ?? null;
    const seen = a ? this.limitsSeen.get(a.provider) : undefined;
    const exhausted =
      seen && Date.parse(seen.updatedAt) >= l.turnStartedAt - 1000 ? seen.windows.find((w) => w.status === "exhausted") : undefined;
    if (!fromText && !exhausted) return null;
    const hit: LimitHit = {
      message: fromText?.message ?? `${a?.provider} ${exhausted?.label ?? exhausted?.id} limit reached`,
      resetsAt: exhausted?.resetsAt ?? fromText?.resetsAt,
    };
    // Record it so other agents of this provider wait too.
    if (a && !exhausted)
      this.recordLimits(a.provider, { windows: [{ id: "limit", label: "usage limit", status: "exhausted", resetsAt: hit.resetsAt ?? retryAt(hit, 0).toISOString() }] });
    if (a && exhausted && !exhausted.resetsAt && transientRateLimit(hit.message))
      this.recordLimits(a.provider, { windows: [{ ...exhausted, resetsAt: retryAt(hit, 0).toISOString() }] });
    return hit;
  }

  // When the provider's limits say it's blocked, the time it resets (or a guess).
  private exhaustedUntil(provider: ProviderId): string | null {
    const seen = this.limitsSeen.get(provider);
    const times = seen?.windows.filter((w) => w.status === "exhausted").map((w) =>
      w.resetsAt ? Date.parse(w.resetsAt) : Date.parse(seen.updatedAt) + 15 * 60_000,
    ) ?? [];
    const reset = Math.max(0, ...times.filter(Number.isFinite));
    return reset > Date.now() ? new Date(reset).toISOString() : null;
  }

  // Sends the first pending message when the agent is idle, strictly in order:
  // a "failed" one holds the queue until it is retried or cancelled, a "limit"
  // one until its time. While the provider is known to be over its limit, the
  // first one waits for the reset as a "limit" message.
  private runNext(id: string, now = Date.now()) {
    const a = this.store.getAgent(id);
    const l = this.liveFor(id);
    if (!a || l.turnId) return;
    if (a.archivedAt) return;
    const m = this.store.listPending(id)[0];
    if (!m || m.reason === "failed") return;
    if (m.notBefore && Date.parse(m.notBefore) > now) return;
    if (m.reason === "queued") {
      const until = this.exhaustedUntil(a.provider);
      if (until) {
        this.store.removePending(m.id);
        this.store.addPending({ ...m, reason: "limit", notBefore: until, note: `${a.provider} is over its usage limit`, front: true });
        return this.changed(id);
      }
    }
    this.store.removePending(m.id);
    // A retried limit message that hits the limit again backs off further.
    if (m.reason === "limit") this.retryAttempts.set(id, m.attempts + 1);
    try {
      this.startTurn(a, l, { text: m.text, images: m.images, id: m.id, sender: m.sender });
    } catch (e) {
      // A turn that started and failed has kept it as failed already.
      if (e instanceof DispatchFailed) return this.changed(id);
      // A refusal (e.g. the folder is gone) won't pass on retry: keep it for the user.
      if (e instanceof RpcError) this.store.addPending({ ...m, reason: "failed", notBefore: null, note: e.message, front: true });
      // Couldn't start (e.g. provider gone): put it back with backoff.
      else this.store.addPending({ ...m, reason: "limit", notBefore: retryAt({ message: m.note ?? "" }, m.attempts + 1).toISOString(), attempts: m.attempts + 1, front: true });
    }
    this.changed(id);
  }

  // At startup: a kept "failed" prompt the agent went on to answer anyway (its
  // process outlived a server stop) is delivered; drop it.
  async dropAnsweredFailed() {
    for (const m of this.store.listPending()) {
      if (m.reason !== "failed") continue;
      const items = await this.currentHistory(m.agentId).then((h) => h.slice(-50), () => []);
      const asked = items.findLastIndex((i) => i.kind === "user" && i.text === m.text);
      if (asked >= 0 && items.slice(asked + 1).some((i) => i.kind === "assistant")) {
        this.store.removePending(m.id);
        this.changed(m.agentId);
      }
    }
  }

  // Called on a timer: sends due pending messages of idle agents.
  runDuePending(now = Date.now()) {
    for (const agentId of new Set(this.store.listPending().map((m) => m.agentId))) this.runNext(agentId, now);
  }

  private recordLimits(provider: ProviderId, update: Omit<ProviderLimits, "provider" | "updatedAt">, authoritative = false) {
    const prev = this.limitsSeen.get(provider);
    const limits: ProviderLimits = {
      provider,
      plan: update.plan ?? prev?.plan,
      windows: mergeWindows(authoritative ? (prev?.windows ?? []).filter((w) => update.windows.some((fresh) => fresh.id === w.id)) : prev?.windows ?? [], update.windows),
      updatedAt: new Date().toISOString(),
    };
    this.store.saveProviderAvailability(limits);
    this.limitsSeen.set(provider, limits);
    this.notify("provider.limits", { limits });
    return limits;
  }

  async limits(only?: ProviderId, refresh = false): Promise<ProviderLimits[]> {
    const ids = only ? [only] : this.providerIds();
    const out: ProviderLimits[] = [];
    for (const id of ids) {
      const p = this.provider(id);
      // Live events alone can leave a window without its usage; ask the account once then.
      const seen = this.limitsSeen.get(id);
      const unknown = !this.limitsQueried.has(id) && seen?.windows.some((w) => w.usedPercent == null);
      if ((refresh || !seen || unknown) && p.limits) {
        this.limitsQueried.add(id);
        const fresh = await p.limits().catch(() => null);
        if (fresh) {
          // An empty report is not evidence that previously exhausted windows
          // recovered. Keep admission blocked for other agents of this provider.
          this.recordLimits(id, fresh, refresh && fresh.windows.length > 0);
          // A successful explicit account refresh can discover an upgraded plan
          // or an early reset. An unavailable/empty response cannot release work.
          const available = fresh.windows.length > 0 && fresh.windows.every((w) =>
            w.status === "ok" || (w.status !== "exhausted" && w.usedPercent !== undefined && w.usedPercent < 100),
          );
          if (refresh && available) {
            for (const agent of this.store.listAgents()) {
              if (agent.provider !== id || !this.store.releaseLimited(agent.id)) continue;
              this.changed(agent.id);
              this.runNext(agent.id);
            }
          }
        }
      }
      const latest = this.limitsSeen.get(id);
      if (latest) out.push(latest);
    }
    return out;
  }

  async subagentHistory(id: string, subagentId: string, limit = 500): Promise<Item[]> {
    const a = this.agent(id);
    const p = this.provider(a.provider);
    // A subagent from a session left by /restart (agent.history prefixed its id).
    const past = /^past(\d+):(.*)$/s.exec(subagentId);
    const session = past ? this.store.pastSessions(id)[Number(past[1])]?.nativeSessionId : a.nativeSessionId;
    if (!session || !p.subagentHistory) return [];
    return (await p.subagentHistory(session, a.cwd, past ? past[2] : subagentId)).slice(-limit);
  }

  async usage(id: string): Promise<Usage | null> {
    const a = this.agent(id);
    const live = this.live.get(id)?.lastUsage;
    if (live) return live;
    if (!a.nativeSessionId) return null;
    return this.provider(a.provider).usage(a.nativeSessionId, a.cwd);
  }

  commands(id: string, refresh = false): Promise<Command[]> {
    const a = this.agent(id);
    const key = JSON.stringify([a.provider, a.cwd]);
    const cached = this.commandCache.get(key);
    if (cached && (cached.pending || (!refresh && Date.now() - cached.at < 5 * 60_000))) return cached.promise;
    const entry = { at: 0, pending: true, promise: Promise.resolve([] as Command[]) };
    entry.promise = Promise.resolve().then(() => this.provider(a.provider).commands(a.cwd)).then(
      (commands) => {
        entry.at = Date.now();
        entry.pending = false;
        return commands;
      },
      (error) => {
        this.commandCache.delete(key);
        throw error;
      },
    );
    this.commandCache.set(key, entry);
    return entry.promise;
  }

  // The transcript the user sees: sessions left by /restart first, each closed
  // by a divider, then the current one. Their item ids get a `past<n>:` prefix
  // so they can't collide with the current session's.
  async history(id: string, before?: number, limit = 200): Promise<{ items: Item[]; start: number; total: number }> {
    const a = this.agent(id);
    const past = this.store.pastSessions(id);
    const all: Item[] = [];
    for (const [n, s] of past.entries()) {
      const items = await this.sessionHistory(a, s.nativeSessionId).catch(() => []);
      all.push(...items.map((item) => ({ ...item, id: `past${n}:${item.id}` })), {
        kind: "notice", id: `restart:${n}`, at: s.endedAt, level: "info", restart: true,
        text: "Session restarted: earlier messages are not in the agent's context",
      });
    }
    if (a.nativeSessionId) all.push(...await this.sessionHistory(a, a.nativeSessionId));
    const end = Math.min(before ?? all.length, all.length);
    const start = Math.max(0, end - limit);
    return { items: all.slice(start, end), start, total: all.length };
  }

  private async sessionHistory(a: StoredAgent, nativeSessionId: string): Promise<Item[]> {
    const provider = this.provider(a.provider);
    const aliases = await provider.historyAliases?.(nativeSessionId, a.cwd) ?? {};
    return (await provider.history(nativeSessionId, a.cwd)).map((item) => {
      if (item.kind !== "user") return item;
      const sender = this.store.messageSender(a.id, item.id) ?? (aliases[item.id] ? this.store.messageSender(a.id, aliases[item.id]) : undefined);
      return sender ? { ...item, sender } : item;
    });
  }

  // What the current native session holds, for the server's own checks.
  private async currentHistory(id: string): Promise<Item[]> {
    const a = this.agent(id);
    return a.nativeSessionId ? this.sessionHistory(a, a.nativeSessionId) : [];
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
    // Only without a turn since the server started: an interrupted or failed
    // turn has no reply, and an older one would read as its answer.
    if (lastReply === null && !l.lastTurn && this.status(id) === "idle") {
      const items = await this.currentHistory(id);
      lastReply = items.findLast((i) => i.kind === "assistant")?.text ?? null;
    }
    return { status: this.status(id), timedOut, lastReply, lastTurn: l.lastTurn };
  }

  async shutdown() {
    clearInterval(this.deferTimer);
    // Prompts the agent hasn't answered yet would be gone after the restart;
    // keep them like failed ones. Not resent: the agent may have stored them.
    for (const [id, l] of this.live) if (l.turnId) this.keepUnanswered(id, l, "the server stopped before the agent answered");
    this.stopped = true;
    await Promise.all([...this.live.values()].map((l) => l.session?.close().catch(() => {})));
  }
}

// Live agent state. Everything here is in memory and rebuilt lazily: a session
// is opened on the first send and the status is derived from it.
import { randomBytes, randomUUID } from "node:crypto";
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
  ProviderLimits,
  QuestionRequest,
  SubagentInfo,
  SubagentItem,
  Usage,
} from "@casm/protocol";
import type { StoredAgent, Store } from "./db.ts";
import type { PermissionAnswer, Provider, ProviderEvent, ProviderSession } from "./providers/types.ts";
import { CASM_TOOL_NAMES, casmMcpEntry } from "./mcp.ts";
import { AgentPrompt, type PromptVars } from "./agent-prompt.ts";
import { limitFromText, mergeWindows, retryAt, type LimitHit } from "./limits.ts";

// What sessions are told about the server that runs them.
export type SessionContext = { serverId: string; serverName: string; mcpUrl: string | null };

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
  statusWaiters: Set<() => void>;
  // Subagent items the provider reported since the server started, by id, kept
  // across turns: background ones finish while the agent is idle.
  subagents: Map<string, Tracked>;
};

// The latest subagent item and when it was seen. `stale`: it was running when
// its session ended, so it will never report finishing.
type Tracked = { item: SubagentItem; startedAt: string; updatedAt: string; stale?: boolean };

// Finished subagents kept per agent for agent.subagents.
const KEEP_FINISHED = 50;

export type Prompt = { text: string; images?: ImageData[] };

export type Notify = <N extends NotificationName>(name: N, params: NotificationParams<N>, agentId?: string) => void;

export class AgentManager {
  private commandCache = new Map<string, { at: number; pending: boolean; promise: Promise<Command[]> }>();
  private live = new Map<string, Live>();
  private catalogs = new Map<ProviderId, { at: number; catalog: Promise<Catalog> }>();
  // Latest account limits per provider, as sessions or queries reported them.
  private limitsSeen = new Map<ProviderId, ProviderLimits>();
  private limitsQueried = new Set<ProviderId>();
  // Per-agent MCP bearer tokens, minted when a session opens. Memory only.
  private mcpTokens = new Map<string, string>();
  private mcpTokenOf = new Map<string, string>();
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
    // Pending messages survive restarts; send due ones every 15 s.
    this.deferTimer = setInterval(() => this.runDuePending(), 15_000);
    this.deferTimer.unref();
  }

  setContext(ctx: SessionContext) {
    this.context = ctx;
  }

  // The agent a casm MCP token was minted for.
  agentForMcpToken(token: string): string | undefined {
    return this.mcpTokens.get(token);
  }

  private mintMcpToken(agentId: string): string {
    const old = this.mcpTokenOf.get(agentId);
    if (old) this.mcpTokens.delete(old);
    const token = "casm_agent_" + randomBytes(24).toString("base64url");
    this.mcpTokens.set(token, agentId);
    this.mcpTokenOf.set(agentId, token);
    return token;
  }

  // The stored config plus what the server adds to every session: CASM_* env
  // vars (so `casm run` from inside links the child), with casmTools the casm
  // MCP server, and the host's agent prompt ahead of the agent's own.
  private sessionConfig(a: StoredAgent): AgentConfig {
    const ctx = this.context;
    if (!ctx) return a.config;
    const env = { ...a.config.env, CASM_SERVER_ID: ctx.serverId, CASM_SERVER_NAME: ctx.serverName, CASM_AGENT_ID: a.id };
    let mcpServers = a.config.mcpServers;
    let casmTools = false;
    if (a.config.casmTools && ctx.mcpUrl) {
      const entry = casmMcpEntry(a.provider, ctx.mcpUrl, this.mintMcpToken(a.id));
      if (entry) (mcpServers = { ...mcpServers, casm: entry }), (casmTools = true);
    }
    const hostPrompt = this.agentPrompt.render(this.promptVars(a, casmTools));
    const systemPrompt = [hostPrompt, a.config.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    return { ...a.config, env, mcpServers, systemPrompt };
  }

  // What the agent prompt's placeholders stand for, for this agent.
  promptVars(a: Pick<StoredAgent, "id" | "name" | "projectId" | "cwd" | "provider">, casmTools: boolean): PromptVars {
    return {
      host: this.context?.serverName ?? "",
      agentId: a.id,
      agentName: a.name,
      project: this.store.getProject(a.projectId)?.name ?? a.projectId,
      cwd: a.cwd,
      provider: a.provider,
      casmTools: casmTools ? CASM_TOOL_NAMES : null,
    };
  }

  // Whether this agent's sessions get casm's MCP tools.
  hasCasmTools(a: StoredAgent): boolean {
    return !!(a.config.casmTools && this.context?.mcpUrl && casmMcpEntry(a.provider, "", ""));
  }

  providerIds(): ProviderId[] {
    return [...this.providers.keys()];
  }

  installedProviders(): Provider[] {
    return [...this.providers.values()];
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
      pending: { count: pending.length, ...(times[0] ? { next: times[0] } : {}) },
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
        const items = await this.history(agentId, undefined, 100_000).then((h) => h.items, () => []);
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
    if (n) this.changed(id);
    return n;
  }

  retryPending(id: string, messageId: string) {
    const m = this.store.listPending(id).find((x) => x.id === messageId);
    if (!m) throw new RpcError(1001, "no such pending message");
    if (m.reason !== "failed") throw new RpcError(-32602, `only failed messages can be retried; this one is ${m.reason}`);
    return this.resend(id, m, "queue");
  }

  // Sends a pending message right away, its images included: into the running
  // turn, or as a new turn when the agent is idle.
  steerPending(id: string, messageId: string) {
    this.agent(id);
    const m = this.store.listPending(id).find((x) => x.id === messageId);
    if (!m) throw new RpcError(1001, "no such pending message (it may have been sent or cancelled already)");
    return this.resend(id, m, "steer");
  }

  // Removes a pending message and returns its full prompt, e.g. to edit it.
  takePending(id: string, messageId: string): Prompt {
    this.agent(id);
    const m = this.store.listPending(id).find((x) => x.id === messageId);
    if (!m || !this.store.removePending(m.id)) throw new RpcError(1001, "no such pending message (it may have been sent or cancelled already)");
    this.changed(id);
    return { text: m.text, ...(m.images?.length ? { images: m.images } : {}) };
  }

  // Takes a pending message out and sends it; if that throws, it is kept again.
  private resend(id: string, m: ReturnType<Store["listPending"]>[number], whenBusy: "queue" | "steer") {
    this.store.removePending(m.id);
    const before = new Set(this.store.listPending(id).map((x) => x.id));
    try {
      return this.send(id, { text: m.text, images: m.images }, whenBusy);
    } catch (e) {
      // A turn that started and failed has kept it again already.
      const keptAgain = this.store.listPending(id).some((x) => !before.has(x.id) && x.reason === "failed" && x.text === m.text);
      if (!keptAgain) this.store.addPending({ ...m, front: true });
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
      l = { session: null, generation: 0, turnId: null, turn: [], pending: new Map(), reloadAfterTurn: false, lastReply: null, lastUsage: null, prompt: null, turnStartedAt: 0, lastTurn: null, answers: 0, steered: [], statusWaiters: new Set(), subagents: new Map() };
      this.live.set(id, l);
    }
    return l;
  }

  private emit(id: string, event: AgentEvent) {
    const l = this.liveFor(id);
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
  ): { queued: boolean; deferredUntil?: string; pendingId?: string } {
    const a = this.agent(id);
    if (a.archivedAt) throw new RpcError(1003, "agent is archived");
    if (!prompt.text.trim() && !prompt.images?.length) throw new RpcError(-32602, "nothing to send");
    // A message already waiting on a limit, or the provider known to be over it: wait too.
    const waiting = this.store.listPending(id).find((m) => m.reason === "limit");
    const blocked = waiting ? null : this.exhaustedUntil(a.provider);
    if (waiting || blocked) {
      const reason = waiting?.note ?? `${a.provider} is over its usage limit`;
      const until = waiting?.notBefore ?? blocked!;
      if (whenLimited === "fail") throw new RpcError(1004, `${reason}; resets ${until}`);
      const m = this.store.addPending({ agentId: id, ...prompt, reason: waiting ? "queued" : "limit", notBefore: waiting ? null : until, note: waiting ? null : reason });
      this.changed(id);
      return { queued: true, deferredUntil: until, pendingId: m.id };
    }
    const l = this.liveFor(id);
    if (l.turnId) {
      if (whenBusy === "queue") {
        const m = this.store.addPending({ agentId: id, ...prompt, reason: "queued", notBefore: null, note: null });
        this.changed(id);
        return { queued: true, pendingId: m.id };
      }
      l.steered.push({ prompt, answersAt: l.answers });
      this.sendToSession(id, l, prompt);
      return { queued: false };
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
    this.guard(id, l, () => l.session!.shell(command, randomUUID()));
  }

  // A provider that throws while starting work must not leave the agent "running".
  private guard(id: string, l: Live, start: () => void) {
    try {
      start();
    } catch (e) {
      if (l.turnId) this.endTurn(id, l, "failed", e instanceof Error ? e.message : String(e));
      throw new RpcError(-32603, e instanceof Error ? e.message : String(e));
    }
  }

  private sendToSession(id: string, l: Live, prompt: Prompt) {
    const itemId = randomUUID();
    const images = prompt.images?.length ? prompt.images : undefined;
    this.emit(id, { type: "item", item: { kind: "user", id: itemId, text: prompt.text, images } });
    this.guard(id, l, () => l.session!.send(prompt.text, itemId, images));
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
      case "item":
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
      // Retry the prompt that hit the limit first; anything queued waits behind it.
      const attempts = this.retryAttempts.get(id) ?? 0;
      this.store.addPending({
        agentId: id,
        ...l.prompt,
        reason: "limit",
        notBefore: retryAt(limit, attempts).toISOString(),
        note: limit.message,
        attempts,
        front: true,
      });
      // Prompts steered in that got no answer are kept too.
      l.prompt = null;
      const kept = this.keepUnanswered(id, l, limit.message);
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
    }
    this.runNext(id);
  }

  // Keeps the turn's prompts nothing came back for (the one that started it and
  // any steered in later) as failed pending messages, in order. Returns their ids.
  private keepUnanswered(id: string, l: Live, note: string): string[] {
    const prompts = [...(l.prompt && !l.answers ? [l.prompt] : []), ...l.steered.filter((s) => s.answersAt === l.answers).map((s) => s.prompt)];
    const ids = prompts.map((p) => this.store.addPending({ agentId: id, ...p, reason: "failed", notBefore: null, note }).id);
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
    // Interrupt also drops the agent's pending messages.
    if (this.store.clearPending(id)) this.changed(id);
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

  // Like reload, but the next send starts a new native session.
  async restart(id: string) {
    await this.reload(id);
    const updated = this.store.updateAgent(id, { nativeSessionId: null })!;
    this.notify("agent.changed", { agent: this.withStatus(updated) });
  }

  async remove(id: string) {
    await this.reload(id).catch(() => {});
    this.live.delete(id);
    const token = this.mcpTokenOf.get(id);
    if (token) (this.mcpTokens.delete(token), this.mcpTokenOf.delete(id));
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
      this.recordLimits(a.provider, { windows: [{ id: "limit", label: "usage limit", status: "exhausted", resetsAt: hit.resetsAt }] });
    return hit;
  }

  // When the provider's limits say it's blocked, the time it resets (or a guess).
  private exhaustedUntil(provider: ProviderId): string | null {
    const seen = this.limitsSeen.get(provider);
    const w = seen?.windows.find((x) => x.status === "exhausted");
    if (!w) return null;
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Date.parse(seen!.updatedAt) + 15 * 60_000;
    return reset > Date.now() ? new Date(reset).toISOString() : null;
  }

  // Sends the next pending message when the agent is idle. A "limit" message
  // that isn't due yet holds back everything behind it.
  private runNext(id: string, now = Date.now()) {
    const a = this.store.getAgent(id);
    const l = this.liveFor(id);
    if (!a || l.turnId) return;
    if (a.archivedAt) return;
    for (const m of this.store.listPending(id)) {
      if (m.reason === "failed") continue;
      const due = !m.notBefore || Date.parse(m.notBefore) <= now;
      if (!due && m.reason === "limit") return;
      if (!due) continue;
      this.store.removePending(m.id);
      // A retried limit message that hits the limit again backs off further.
      if (m.reason === "limit") this.retryAttempts.set(id, m.attempts + 1);
      try {
        this.startTurn(a, l, { text: m.text, images: m.images });
      } catch (e) {
        // A refusal (e.g. the folder is gone) won't pass on retry: keep it for the user.
        if (e instanceof RpcError) this.store.addPending({ ...m, reason: "failed", notBefore: null, note: e.message, front: true });
        // Couldn't start (e.g. provider gone): put it back with backoff.
        else this.store.addPending({ ...m, reason: "limit", notBefore: retryAt({ message: m.note ?? "" }, m.attempts + 1).toISOString(), attempts: m.attempts + 1, front: true });
      }
      this.changed(id);
      return;
    }
  }

  // At startup: a kept "failed" prompt the agent went on to answer anyway (its
  // process outlived a server stop) is delivered; drop it.
  async dropAnsweredFailed() {
    for (const m of this.store.listPending()) {
      if (m.reason !== "failed") continue;
      const items = await this.history(m.agentId, undefined, 50).then((h) => h.items, () => []);
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

  private recordLimits(provider: ProviderId, update: Omit<ProviderLimits, "provider" | "updatedAt">) {
    const prev = this.limitsSeen.get(provider);
    const limits: ProviderLimits = {
      provider,
      plan: update.plan ?? prev?.plan,
      windows: mergeWindows(prev?.windows ?? [], update.windows),
      updatedAt: new Date().toISOString(),
    };
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
        if (fresh) this.recordLimits(id, fresh);
      }
      const latest = this.limitsSeen.get(id);
      if (latest) out.push(latest);
    }
    return out;
  }

  async subagentHistory(id: string, subagentId: string, limit = 500): Promise<Item[]> {
    const a = this.agent(id);
    const p = this.provider(a.provider);
    if (!a.nativeSessionId || !p.subagentHistory) return [];
    return (await p.subagentHistory(a.nativeSessionId, a.cwd, subagentId)).slice(-limit);
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
    // Only without a turn since the server started: an interrupted or failed
    // turn has no reply, and an older one would read as its answer.
    if (lastReply === null && !l.lastTurn && this.status(id) === "idle") {
      const { items } = await this.history(id, undefined, 50);
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

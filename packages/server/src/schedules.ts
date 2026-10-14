// Host-level schedules: on a cadence, message an existing agent or create a
// new one from a preset. Runs go through the normal agent paths, so a message
// to a busy or limited agent simply becomes a pending message.
import { randomUUID } from "node:crypto";
import type { Agent, Params, Schedule, ScheduleCadence, ScheduleRun } from "@casm/protocol";
import { RpcError, type AgentManager, type Notify } from "./agents.ts";
import type { Store } from "./db.ts";
import { nextCron, parseCron } from "./cron.ts";

export function nextRun(c: ScheduleCadence, after: Date, alreadyRan = false): Date | null {
  switch (c.type) {
    case "cron":
      return nextCron(parseCron(c.expr), after);
    case "every":
      return new Date(after.getTime() + c.minutes * 60_000);
    case "once":
      return alreadyRan ? null : new Date(c.at);
  }
}

function validate(c: ScheduleCadence) {
  try {
    if (c.type === "cron") parseCron(c.expr);
    if (c.type === "once" && Number.isNaN(Date.parse(c.at))) throw new Error(`invalid time "${c.at}"`);
  } catch (e) {
    throw new RpcError(-32602, (e as Error).message);
  }
}

type CreateAgent = (p: Params<"agent.create">) => Promise<Agent>;

export class Scheduler {
  private store: Store;
  private agents: AgentManager;
  private notify: Notify;
  private createAgent: CreateAgent;
  private timer: ReturnType<typeof setInterval>;
  private running = new Set<string>();

  constructor(store: Store, agents: AgentManager, notify: Notify, createAgent: CreateAgent) {
    this.store = store;
    this.agents = agents;
    this.notify = notify;
    this.createAgent = createAgent;
    // A run missed while the server was down happens once on the next tick.
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  list(agentId?: string): Schedule[] {
    const all = this.store.listSchedules();
    return agentId ? all.filter((x) => x.target.type === "agent" && x.target.agentId === agentId) : all;
  }

  private get(id: string): Schedule {
    const x = this.store.getSchedule(id);
    if (!x) throw new RpcError(1001, `schedule ${id} not found`);
    return x;
  }

  private checkTarget(t: Schedule["target"]) {
    if (t.type === "agent" && !this.store.getAgent(t.agentId)) throw new RpcError(1001, `agent ${t.agentId} not found`);
    if (t.type === "newAgent" && !this.store.getProject(t.projectId)) throw new RpcError(1001, `project ${t.projectId} not found`);
  }

  private save(x: Schedule): Schedule {
    this.store.saveSchedule(x);
    this.notify("schedule.changed", { schedule: x });
    return x;
  }

  create(p: Params<"schedule.create">): Schedule {
    validate(p.cadence);
    this.checkTarget(p.target);
    const now = new Date();
    const enabled = p.enabled ?? true;
    const name =
      p.name ??
      (p.target.type === "agent" ? `→ ${this.store.getAgent(p.target.agentId)?.name}` : `new ${p.target.provider} agent`);
    return this.save({
      id: randomUUID(),
      name,
      enabled,
      cadence: p.cadence,
      target: p.target,
      prompt: p.prompt,
      nextRunAt: enabled ? (nextRun(p.cadence, now)?.toISOString() ?? null) : null,
      lastRun: null,
      createdAt: now.toISOString(),
    });
  }

  update(p: Params<"schedule.update">): Schedule {
    const x = this.get(p.id);
    if (p.cadence) validate(p.cadence);
    if (p.target) this.checkTarget(p.target);
    const next: Schedule = {
      ...x,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.cadence ? { cadence: p.cadence } : {}),
      ...(p.target ? { target: p.target } : {}),
      ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
    };
    const ranOnce = next.cadence.type === "once" && x.lastRun !== null && !p.cadence;
    next.nextRunAt = next.enabled ? (nextRun(next.cadence, new Date(), ranOnce)?.toISOString() ?? null) : null;
    return this.save(next);
  }

  delete(id: string) {
    this.get(id);
    this.store.deleteSchedule(id);
    this.notify("schedule.removed", { scheduleId: id });
  }

  // Schedules whose agent is deleted go too.
  agentRemoved(agentId: string) {
    for (const x of this.list(agentId)) this.delete(x.id);
  }

  async runNow(id: string): Promise<ScheduleRun> {
    return this.run(this.get(id), false);
  }

  async tick(now = new Date()) {
    for (const x of this.store.listSchedules()) {
      if (!x.enabled || !x.nextRunAt || Date.parse(x.nextRunAt) > now.getTime()) continue;
      await this.run(x, true, now);
    }
  }

  private async run(x: Schedule, advance: boolean, now = new Date()): Promise<ScheduleRun> {
    if (this.running.has(x.id)) return { at: now.toISOString(), outcome: "skipped", error: "previous run still starting" };
    this.running.add(x.id);
    let run: ScheduleRun;
    try {
      run = await this.fire(x, now);
    } catch (e) {
      run = { at: now.toISOString(), outcome: "failed", error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.running.delete(x.id);
    }
    const fresh = this.store.getSchedule(x.id);
    if (!fresh) return run;
    const updated: Schedule = { ...fresh, lastRun: run };
    if (advance) {
      updated.nextRunAt = nextRun(fresh.cadence, now, true)?.toISOString() ?? null;
      if (fresh.cadence.type === "once") updated.enabled = false;
    }
    this.save(updated);
    return run;
  }

  private async fire(x: Schedule, now: Date): Promise<ScheduleRun> {
    const at = now.toISOString();
    const t = x.target;
    const sender = this.agents.scheduleSender(x.id, x.name);
    if (t.type === "agent") {
      const a = this.store.getAgent(t.agentId);
      if (!a) return { at, outcome: "failed", error: "agent no longer exists" };
      if (t.whenBusy === "skip" && (this.agents.status(a.id) !== "idle" || this.store.listPending(a.id).length > 0))
        return { at, outcome: "skipped", agentId: a.id };
      const r = this.agents.send(a.id, { text: x.prompt, sender });
      return { at, outcome: r.queued ? "queued" : "sent", agentId: a.id };
    }
    const stamp = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const created = await this.createAgent({
      projectId: t.projectId,
      provider: t.provider,
      config: t.config,
      name: `${t.name ?? x.name} · ${stamp}`,
      prompt: x.prompt,
      sender,
    });
    return { at, outcome: "created", agentId: created.id };
  }
}

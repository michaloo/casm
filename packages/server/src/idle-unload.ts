// Idle unload: stops the provider process of agents left idle longer than the
// host's idleUnloadMinutes, to give back the memory their CLI and MCP servers
// hold. The session stays; the next message resumes it as after a reload.
import type { ProviderId } from "@casm/protocol";

// What the manager knows about one agent with an open provider process.
export type IdleFacts = {
  agentId: string;
  provider: ProviderId;
  // A turn running, or input still being handed to the provider.
  busy: boolean;
  // Open permission requests and questions, async ones included.
  blocked: number;
  // Pending messages of any kind: queued, limit-deferred or failed.
  pending: number;
  // Provider-internal subagents still running (they run while the agent is idle).
  subagents: number;
  // Being archived or deleted, or due to reload once the turn ends.
  closing: boolean;
  // A schedule is delivering to it right now.
  scheduled: boolean;
  // Epoch ms of the last sign of life: a turn, an event, a session opened.
  lastActive: number;
};

// Why the agent keeps its process, or null when it may be unloaded.
export function keepLoaded(f: IdleFacts, now: number, thresholdMs: number): string | null {
  if (thresholdMs <= 0) return "idle unload is off";
  if (f.busy) return "running";
  if (f.blocked) return "waiting on a permission or question";
  if (f.pending) return "has pending messages";
  if (f.subagents) return "subagents running";
  if (f.closing) return "closing";
  if (f.scheduled) return "a schedule is running";
  if (now - f.lastActive < thresholdMs) return "recently active";
  return null;
}

// The agents to unload now. Agents of a provider whose process is shared by
// all its agents (OpenCode's `opencode serve`) go together, and only when each
// of them may: unloading some would free nothing.
export function pickUnloads(facts: IdleFacts[], now: number, thresholdMs: number, shared: ReadonlySet<ProviderId>): string[] {
  const out: string[] = [];
  const groups = new Map<ProviderId, IdleFacts[]>();
  for (const f of facts) {
    if (shared.has(f.provider)) groups.set(f.provider, [...(groups.get(f.provider) ?? []), f]);
    else if (!keepLoaded(f, now, thresholdMs)) out.push(f.agentId);
  }
  for (const group of groups.values())
    if (group.every((f) => !keepLoaded(f, now, thresholdMs))) out.push(...group.map((f) => f.agentId));
  return out;
}

export const IDLE_CHECK_MS = 15_000;

// Checks on a timer. `minutes` is read on every check, so a changed setting
// applies without a restart.
export class IdleUnloader {
  private timer: ReturnType<typeof setInterval>;
  private run: () => void;

  constructor(target: { idleFacts(): IdleFacts[]; unloadIdle(ids: string[]): void; sharedProviders(): ReadonlySet<ProviderId> }, minutes: () => number, everyMs = IDLE_CHECK_MS) {
    this.run = () => {
      const ids = pickUnloads(target.idleFacts(), Date.now(), minutes() * 60_000, target.sharedProviders());
      if (ids.length) target.unloadIdle(ids);
    };
    this.timer = setInterval(() => this.check(), everyMs);
    this.timer.unref();
  }

  check() {
    try {
      this.run();
    } catch {
      // A failed check (e.g. a closed store at shutdown) waits for the next one.
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

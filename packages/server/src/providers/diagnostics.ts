import type { Item } from "@casm/protocol";

const rec = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === "string" ? v : "";

// Session-local reducers keep transient progress on one row. These rows are
// supplemented into history because neither provider guarantees persistence.
export class Diagnostics {
  private completedPlans = new Set<string>();
  private hooks = new Map<string, { turnId: string; background: boolean }>();
  private rows = new Map<string, Item>();
  codex(method: string, p: Record<string, unknown>): Item | null {
    if (method === "item/completed" && rec(p.item).type === "plan") {
      const id = str(rec(p.item).id);
      this.completedPlans.add(id);
      this.rows.delete(id);
      return null;
    }
    if (method === "item/plan/delta") {
      const id = str(p.itemId);
      if (!id || this.completedPlans.has(id) || !str(p.delta)) return null;
      const previous = this.rows.get(id);
      return this.keep({ kind: "assistant", id, text: (previous?.kind === "assistant" ? previous.text : "") + str(p.delta) });
    }
    if (method === "thread/goal/updated") {
      const g = rec(p.goal);
      return this.keep({ kind: "notice", id: `goal:${str(p.threadId)}`, level: "info", text: `Goal (${str(g.status)}): ${str(g.objective)}\nTokens used: ${g.tokensUsed ?? 0}${g.tokenBudget == null ? "" : ` / ${g.tokenBudget}`} · Time used: ${g.timeUsedSeconds ?? 0}s` });
    }
    if (method === "thread/goal/cleared") return this.keep({ kind: "notice", id: `goal:${str(p.threadId)}`, level: "info", text: "Goal cleared" });
    if (method.startsWith("modelProvider/authRecovery")) return this.keep({ kind: "notice", id: `auth:${str(p.turnId)}:${str(p.provider)}`, level: "info", text: `Authentication recovery ${method.endsWith("Started") ? "started" : "completed"} (${str(p.provider)})${p.message ? `: ${str(p.message)}` : ""}` });
    if (method === "hook/started" || method === "hook/completed") {
      const r = rec(p.run);
      if (!str(r.id)) return null;
      const id = `hook:${str(r.id)}`;
      if (method.endsWith("started") && this.finished(id)) return null;
      if (r.status === "running") this.hooks.set(id, { turnId: str(p.turnId), background: r.executionMode === "async" });
      else this.hooks.delete(id);
      // Context entries can contain hidden hook prompts. Only explicit user
      // diagnostics are rendered, never hookPrompt fragments or context.
      const entries = Array.isArray(r.entries) ? r.entries.map(rec).filter(e => e.kind !== "context") : [];
      return this.keep({ kind: "tool", id, name: `Hook: ${str(r.eventName)}`, input: { sourcePath: r.sourcePath, handlerType: r.handlerType, executionMode: r.executionMode }, status: r.status === "running" ? "running" : r.status === "completed" ? "done" : "error", output: [str(r.statusMessage), ...entries.map(e => `${str(e.kind)}: ${str(e.text)}`)].filter(Boolean).join("\n") || `Hook ${str(r.status)}` });
    }
    return null;
  }
  claude(m: Record<string, unknown>): Item | null {
    if (m.type === "auth_status") return this.keep({ kind: "notice", id: `auth:${str(m.session_id)}`, level: m.error ? "error" : "info", text: [m.error ? `Authentication failed: ${str(m.error)}` : m.isAuthenticating ? "Authenticating…" : "Authentication finished", ...(Array.isArray(m.output) ? m.output.map(str) : [])].filter(Boolean).join("\n") });
    if (m.type !== "system" || !["hook_started", "hook_progress", "hook_response"].includes(str(m.subtype)) || !str(m.hook_id)) return null;
    const id = `hook:${str(m.hook_id)}`;
    if (m.subtype !== "hook_response" && this.finished(id)) return null;
    // The SDK exposes no owning turn or sync/async mode. Keep these hooks
    // until a response or process closure, never infer completion from result.
    if (m.subtype === "hook_response") this.hooks.delete(id);
    else this.hooks.set(id, { turnId: "", background: true });
    const output = [str(m.stdout), m.stderr ? `stderr: ${str(m.stderr)}` : "", str(m.output), m.exit_code == null ? "" : `Exit code: ${m.exit_code}`, str(m.outcome)].filter(Boolean).join("\n");
    return this.keep({ kind: "tool", id, name: `Hook: ${str(m.hook_name) || str(m.hook_event)}`, input: { event: m.hook_event }, status: m.subtype !== "hook_response" ? "running" : m.outcome === "success" ? "done" : "error", output });
  }
  // Async hooks and thread-scoped hooks can outlive a turn. None can outlive
  // their provider process. Unknown is not a claim that the hook was cancelled.
  finishHooks(turnId?: string): Item[] {
    const items: Item[] = [];
    for (const [id, hook] of this.hooks) {
      if (turnId !== undefined && (hook.turnId !== turnId || hook.background)) continue;
      this.hooks.delete(id);
      const row = this.rows.get(id);
      if (row?.kind !== "tool" || row.status !== "running") continue;
      items.push(this.keep({ ...row, status: "error", output: `${row.output ? row.output + "\n" : ""}Hook outcome unknown: no completion was recorded before ${turnId === undefined ? "the provider process closed" : "the turn ended"}.` }));
    }
    return items;
  }
  private finished(id: string) { const row = this.rows.get(id); return row?.kind === "tool" && row.status !== "running"; }
  private keep(item: Item): Item {
    item.at = this.rows.get(item.id)?.at ?? new Date().toISOString();
    this.rows.set(item.id, item);
    if (this.rows.size > 2000) this.rows.delete(this.rows.keys().next().value!);
    return item;
  }
}

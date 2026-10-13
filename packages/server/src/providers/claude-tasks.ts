import type { Item } from "@casm/protocol";
import { z } from "zod";

const Status = z.enum(["pending", "running", "paused", "completed", "failed", "killed", "stopped"]);
const TaskEvent = z.object({
  type: z.literal("system"),
  subtype: z.enum(["task_started", "task_updated", "task_progress", "task_notification"]),
  task_id: z.string().min(1),
  tool_use_id: z.string().optional(),
  parent_task_id: z.string().optional(),
  spawn_depth: z.number().optional(),
  run_id: z.string().optional(),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  status: Status.optional(),
  summary: z.string().optional(),
  last_tool_name: z.string().optional(),
  is_backgrounded: z.boolean().optional(),
  skip_transcript: z.boolean().optional(),
  ambient: z.boolean().optional(),
  usage: z.object({
    total_tokens: z.number().finite().nonnegative(),
    tool_uses: z.number().finite().nonnegative(),
    duration_ms: z.number().finite().nonnegative(),
  }).optional(),
  patch: z.object({
    status: Status.optional(),
    description: z.string().optional(),
    error: z.string().optional(),
    is_backgrounded: z.boolean().optional(),
  }).optional(),
});

type TaskState = {
  id: string;
  runId?: string;
  hidden: boolean;
  status: z.infer<typeof Status>;
  description: string;
  agentType?: string;
  background?: boolean;
  summary?: string;
  usage?: z.infer<typeof TaskEvent>["usage"];
  lastTool?: string;
  rendered?: string;
};

function terminal(status: TaskState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "killed" || status === "stopped";
}

// Task lifecycle is independent of the foreground turn. Tool IDs join live
// lifecycle events to the same cards reconstructed from persisted tool calls.
export class ClaudeTasks {
  private readonly tasks = new Map<string, TaskState>();

  start(id: string, input: Record<string, unknown>): Item[] {
    return this.observe({ type: "system", subtype: "task_started", task_id: id,
      description: input.description ?? "Subagent", subagent_type: input.subagent_type });
  }

  result(id: string, output: string, error: boolean, structured: unknown): Item[] | null {
    const state = this.tasks.get(id);
    if (!state) return null;
    const r = structured as { content?: { type: string; text?: string }[]; status?: string; totalTokens?: number; totalToolUseCount?: number; totalDurationMs?: number } | undefined;
    if (!error && (r?.status === "async_launched" || /agent launched successfully|agent is running in the background/i.test(output))) return [];
    return this.observe({ type: "system", subtype: "task_notification", task_id: id, run_id: state.runId,
      status: error ? "failed" : "completed", summary: Array.isArray(r?.content) ? r.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : output,
      ...(r?.totalTokens != null ? { usage: { total_tokens: r.totalTokens, tool_uses: r.totalToolUseCount ?? 0, duration_ms: r.totalDurationMs ?? 0 } } : {}) });
  }

  // Background completions are persisted as harness-authored user messages,
  // not system task_* frames. Call only after checking the record's origin.
  notification(text: string, runId?: string): Item[] {
    if (!text.trim().startsWith("<task-notification>")) return [];
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
    const total = tag("subagent_tokens");
    return this.observe({ type: "system", subtype: "task_notification",
      task_id: tag("task-id"), tool_use_id: tag("tool-use-id"), run_id: runId,
      status: tag("status"), summary: tag("result") ?? tag("summary"),
      ...(total !== undefined ? { usage: { total_tokens: Number(total), tool_uses: Number(tag("tool_uses")), duration_ms: Number(tag("duration_ms")) } } : {}),
    });
  }

  observe(value: unknown): Item[] {
    const parsed = TaskEvent.safeParse(value);
    if (!parsed.success) return [];
    const e = parsed.data;
    if (e.subtype === "task_notification" && (!e.status || !terminal(e.status))) return [];
    if (e.subtype === "task_updated" && !e.patch) return [];
    let state = this.tasks.get(e.task_id) ?? (e.tool_use_id ? this.tasks.get(e.tool_use_id) : undefined);
    if (state?.runId && (!e.run_id || e.run_id < state.runId)) return [];
    const previous = state;
    if (state?.runId && e.run_id && e.run_id !== state.runId) state = undefined;
    if (!state) {
      // Progress/patches carry no ambient flag. Wait for the declaration so a
      // housekeeping task cannot accidentally become visible. A notification
      // can stand alone when we attached after the task started.
      if (e.subtype !== "task_started" && e.subtype !== "task_notification") return [];
      state = { id: previous?.id ?? e.tool_use_id ?? e.task_id, runId: e.run_id, hidden: false, status: "running", description: previous?.description ?? e.task_id, agentType: previous?.agentType };
    }
    this.tasks.set(e.task_id, state);
    this.tasks.set(state.id, state);
    if (e.tool_use_id) this.tasks.set(e.tool_use_id, state);
    state.runId ??= e.run_id;
    state.hidden ||= !!e.parent_task_id || (e.spawn_depth ?? 1) > 1;
    state.hidden ||= e.ambient === true || e.skip_transcript === true;
    if (state.hidden) return [];
    // A late progress/start/patch must not revive a finished run. The terminal
    // notification can still enrich a terminal patch with its final summary.
    if (terminal(state.status) && e.subtype !== "task_notification") return [];

    if (e.subtype === "task_updated") {
      if (!e.patch) return [];
      state.status = e.patch.status ?? state.status;
      state.description = e.patch.description ?? state.description;
      state.background = e.patch.is_backgrounded ?? state.background;
      state.summary = e.patch.error ?? state.summary;
    } else {
      if (e.subtype !== "task_progress") state.description = e.description ?? state.description;
      state.agentType = e.subagent_type ?? state.agentType;
      state.background = e.is_backgrounded ?? state.background;
      state.summary = e.summary ?? state.summary;
      state.usage = e.usage ?? state.usage;
      state.lastTool = e.last_tool_name ?? state.lastTool;
      if (e.subtype === "task_notification") {
        if (!e.status || !terminal(e.status)) return [];
        state.status = e.status;
      }
    }

    const item: Item = {
      kind: "subagent", id: state.id, title: state.description.slice(0, 8000),
      ...(state.agentType ? { agentType: state.agentType } : {}),
      status: state.status === "completed" ? "done" : terminal(state.status) ? "error" : "running",
      ...(state.lastTool && !terminal(state.status) ? { activity: state.lastTool } : {}),
      ...(state.summary ? { summary: state.summary.slice(0, 8000) } : {}),
      ...(state.usage ? { usage: { totalTokens: state.usage.total_tokens, toolUses: state.usage.tool_uses, durationMs: state.usage.duration_ms } } : {}),
    };
    const rendered = JSON.stringify(item);
    if (state.rendered === rendered) return [];
    state.rendered = rendered;
    return [item];
  }
}

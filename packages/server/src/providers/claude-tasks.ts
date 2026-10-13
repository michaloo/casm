import type { Item } from "@casm/protocol";
import { z } from "zod";

const Status = z.enum(["pending", "running", "paused", "completed", "failed", "killed", "stopped"]);
const TaskEvent = z.object({
  type: z.literal("system"),
  subtype: z.enum(["task_started", "task_updated", "task_progress", "task_notification"]),
  task_id: z.string().min(1),
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

// Task lifecycle is independent of the foreground turn: a result message must
// not finish background work. These notices use the existing client surface;
// child transcripts and a durable task registry are separate concerns.
export class ClaudeTasks {
  private readonly tasks = new Map<string, TaskState>();

  observe(value: unknown): Item[] {
    const parsed = TaskEvent.safeParse(value);
    if (!parsed.success) return [];
    const e = parsed.data;
    if (e.subtype === "task_notification" && (!e.status || !terminal(e.status))) return [];
    if (e.subtype === "task_updated" && !e.patch) return [];
    let state = this.tasks.get(e.task_id);
    if (state?.runId && (!e.run_id || e.run_id < state.runId)) return [];
    if (state && e.run_id && e.run_id !== state.runId) state = undefined;
    if (!state) {
      // Progress/patches carry no ambient flag. Wait for the declaration so a
      // housekeeping task cannot accidentally become visible. A notification
      // can stand alone when we attached after the task started.
      if (e.subtype !== "task_started" && e.subtype !== "task_notification") return [];
      state = { runId: e.run_id, hidden: false, status: "running", description: e.task_id };
      this.tasks.set(e.task_id, state);
    }
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
      state.description = e.description ?? state.description;
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

    const status = state.status === "killed" ? "stopped" : state.status;
    const title = state.agentType ? `Subagent (${state.agentType})` : "Task";
    const details: string[] = [];
    if (state.usage) {
      details.push(`${state.usage.tool_uses} tool uses`, `${state.usage.total_tokens} tokens`, `${Math.round(state.usage.duration_ms / 1000)}s`);
    }
    if (state.lastTool && !terminal(state.status)) details.push(`last tool: ${state.lastTool}`);
    const text = [
      `${title} ${status}${state.background && !terminal(state.status) ? " (background)" : ""}: ${state.description}`,
      state.summary,
      details.length ? details.join(" · ") : undefined,
    ].filter(Boolean).join("\n").slice(0, 8000);
    const level = state.status === "failed" ? "error" : status === "stopped" ? "warning" : "info";
    const rendered = `${level}:${text}`;
    if (state.rendered === rendered) return [];
    state.rendered = rendered;
    return [{ kind: "notice", id: `claude-task:${e.task_id}`, text, level }];
  }
}

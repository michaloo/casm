import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

// How a background command ended, as Claude's task events and notices say it.
export type CommandEnd = "completed" | "failed" | "stopped";

export function commandEnd(status: string | undefined): CommandEnd | undefined {
  if (status === "completed" || status === "failed") return status;
  if (status === "stopped" || status === "killed") return "stopped";
  return undefined;
}

// A <task-notification> as Claude persists it (and, for turns it starts
// itself, sends it to the model). An orphan notice, written when a session
// resumes, lists the tasks the previous process left running, possibly several
// with no tool-use-id; its "__orphan_summary__" ids are markers, not tasks.
export type TaskNotice = {
  taskIds: string[];
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
  // A subagent's final answer.
  result?: string;
  orphan: boolean;
};

export function parseTaskNotice(text: string): TaskNotice | null {
  if (!text.trim().startsWith("<task-notification>")) return null;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const all = [...text.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)].map((m) => m[1]!.trim());
  return {
    taskIds: all.filter((id) => id && !id.startsWith("__orphan_summary__")),
    toolUseId: tag("tool-use-id"),
    outputFile: tag("output-file"),
    status: tag("status"),
    summary: tag("summary"),
    result: tag("result"),
    orphan: all.some((id) => id.startsWith("__orphan_summary__")) || /previous session/i.test(tag("note") ?? ""),
  };
}

// The task a tool result left running: Bash (run_in_background, or moved to
// the background after its timeout) and Monitor report it in their structured
// result; the text is the fallback for records without one.
export function backgroundTask(structured: unknown, output: string): { taskId: string; outputFile?: string } | null {
  const r = structured as { backgroundTaskId?: unknown; taskId?: unknown } | undefined;
  const taskId = typeof r?.backgroundTaskId === "string" ? r.backgroundTaskId
    : typeof r?.taskId === "string" && /^Monitor started/.test(output) ? r.taskId
    : /^Command running in background with ID: ([\w-]+)\./.exec(output)?.[1]
      ?? /moved to the background \(ID: ([\w-]+)\)/.exec(output)?.[1];
  if (!taskId) return null;
  const outputFile = /Output is being written to: (\S+\.output)/.exec(output)?.[1];
  return { taskId, ...(outputFile ? { outputFile } : {}) };
}

// The task a TaskStop/KillShell call stopped, from its structured result.
export function stoppedTask(structured: unknown): string | undefined {
  const r = structured as { task_id?: unknown; shell_id?: unknown } | undefined;
  return typeof r?.task_id === "string" ? r.task_id : typeof r?.shell_id === "string" ? r.shell_id : undefined;
}

export const OUTPUT_TAIL_BYTES = 16 * 1024;

// Only the file Claude named for this session's own task:
// <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output. Anything else
// (another path, a symlink, a directory) is not read.
export function outputPathAllowed(file: string, sessionId: string, taskId: string): boolean {
  if (!isAbsolute(file) || normalize(file) !== file || !/^[\w-]+$/.test(taskId) || !/^[\w-]+$/.test(sessionId)) return false;
  const parts = file.split("/");
  return parts.length >= 6 && parts.at(-1) === `${taskId}.output` && parts.at(-2) === "tasks" && parts.at(-3) === sessionId && /^claude-\d+$/.test(parts.at(-5)!);
}

// The end of a background command's output file, starting at a line; null if
// it can't be read (gone with /tmp, or not allowed).
export async function readOutputTail(file: string, sessionId: string, taskId: string, max = OUTPUT_TAIL_BYTES): Promise<string | null> {
  if (!outputPathAllowed(file, sessionId, taskId)) return null;
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - max);
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = `…\n${nl >= 0 ? text.slice(nl + 1) : text}`;
    }
    // Claude ends the file with how the command ended; alone, that is no output.
    return /^\s*(\[(exited with code -?\d+|killed)\]\s*)?$/.test(text) ? null : text.trimEnd();
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// A foreground command's output file, which Claude doesn't name: the
// session's tasks/<task>.output under <tmp>/claude-<uid>/<project>/, created
// when the command starts and deleted when it ends. null until it exists.
export async function findOutputFile(sessionId: string, taskId: string, tmpDirs: (string | undefined)[] = [process.env.CLAUDE_CODE_TMPDIR, process.env.CLAUDE_TMPDIR, tmpdir(), "/tmp"]): Promise<string | null> {
  const uid = process.getuid?.();
  if (uid === undefined || !/^[\w-]+$/.test(taskId) || !/^[\w-]+$/.test(sessionId)) return null;
  for (const base of new Set(tmpDirs.filter((d): d is string => !!d))) {
    const root = join(base, `claude-${uid}`);
    const projects = await readdir(root).catch(() => [] as string[]);
    for (const project of projects) {
      const file = join(root, project, sessionId, "tasks", `${taskId}.output`);
      if (outputPathAllowed(file, sessionId, taskId) && (await stat(file).then((s) => s.isFile(), () => false))) return file;
    }
  }
  return null;
}

type Command = { taskId: string; outputFile?: string; end?: CommandEnd; output?: string };

// Background commands by the tool call that started them. Their task events
// and notices name the task, the tool call, or both.
export class BackgroundCommands {
  private readonly byTool = new Map<string, Command>();
  private readonly toolByTask = new Map<string, string>();

  get(toolId: string): Command | undefined {
    return this.byTool.get(toolId);
  }

  toolOf(taskId: string | undefined): string | undefined {
    return taskId ? this.toolByTask.get(taskId) : undefined;
  }

  start(toolId: string, taskId: string, outputFile?: string): Command {
    let c = this.byTool.get(toolId);
    if (!c) this.byTool.set(toolId, (c = { taskId }));
    c.taskId = taskId;
    c.outputFile ??= outputFile;
    this.toolByTask.set(taskId, toolId);
    return c;
  }

  // The first end wins: a later notice (the notification after its patch, an
  // orphan notice) can't turn a finished command into another outcome.
  end(toolId: string, end: CommandEnd, outputFile?: string): boolean {
    const c = this.byTool.get(toolId);
    if (!c) return false;
    c.outputFile ??= outputFile;
    if (c.end) return false;
    c.end = end;
    return true;
  }

  forget(toolId: string) {
    const c = this.byTool.get(toolId);
    if (!c) return;
    this.byTool.delete(toolId);
    if (this.toolByTask.get(c.taskId) === toolId) this.toolByTask.delete(c.taskId);
  }

  output(toolId: string, text: string): boolean {
    const c = this.byTool.get(toolId);
    if (!c || c.output === text) return false;
    c.output = text;
    return true;
  }

  *all(): Iterable<[string, Command]> {
    yield* this.byTool;
  }
}

// Codex memories (`[features] memories = true`): one global store at
// $CODEX_HOME/memories/, written by Codex's background pipeline (phase 1
// summarizes idle threads into memories_1.sqlite, phase 2 consolidates them
// into these files with a sub-agent). Codex treats the files as generated
// state and rewrites them on every consolidation, so casm only reads them.
//
//   memory_summary.md            loaded into every new session (first line "v1")
//   MEMORY.md                    "# Task Group:" blocks, each tagged "applies_to: cwd=..."
//   rollout_summaries/<slug>.md  one recap per summarized thread, with a "cwd:" header
//   raw_memories.md, skills/     phase-2 input and generated skills (not listed)
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MemoryEntry } from "@casm/protocol";
import type { ProviderMemories } from "./types.ts";

export function codexMemoryDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "memories");
}

// Whether a Codex cwd tag (free text, may hold several paths or a workflow
// name) applies to `project`: an equal, enclosing or nested path. Tags with
// no absolute path ("unknown", a workflow scope) apply everywhere.
export function appliesTo(tag: string | undefined, project: string): boolean {
  const paths = (tag ?? "").match(/(?:^|[\s=(,;`'"])(\/[^\s;,()`'"]*)/g)?.map((m) => m.replace(/^[\s=(,;`'"]/, "").replace(/\/+$/, "") || "/") ?? [];
  if (!paths.length) return true;
  const p = resolve(project);
  return paths.some((x) => x === p || p.startsWith(x === "/" ? "/" : `${x}/`) || x.startsWith(`${p}/`));
}

export type MemoryBlock = { title: string; cwd?: string; text: string };

// Splits MEMORY.md into its "# Task Group:" blocks.
export function parseBlocks(md: string): MemoryBlock[] {
  const out: MemoryBlock[] = [];
  const starts = [...md.matchAll(/^# Task Group:[^\n]*$/gm)].map((m) => m.index!);
  starts.forEach((s, i) => {
    const text = md.slice(s, starts[i + 1] ?? md.length).trimEnd();
    const title = /^# Task Group:\s*(.*)$/m.exec(text)![1].trim();
    const cwd = /^applies_to:\s*cwd=(.*?)(?:;\s*reuse_rule=.*)?$/m.exec(text)?.[1].trim();
    out.push({ title, ...(cwd ? { cwd } : {}), text });
  });
  return out;
}

async function read(file: string): Promise<{ text: string; updatedAt: string } | null> {
  try {
    const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { text, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

export async function codexMemories(cwd: string): Promise<ProviderMemories | null> {
  const dir = codexMemoryDir();
  const entries: MemoryEntry[] = [];

  const summary = await read(join(dir, "memory_summary.md"));
  if (summary?.text.trim()) entries.push({ id: "memory_summary.md", title: "Summary (loaded into every session)", ...summary });

  const handbook = await read(join(dir, "MEMORY.md"));
  if (handbook)
    parseBlocks(handbook.text).forEach((b, i) => {
      if (appliesTo(b.cwd, cwd)) entries.push({ id: `MEMORY.md#${i + 1}`, title: b.title, description: /^scope:\s*(.+)$/m.exec(b.text)?.[1], text: b.text, updatedAt: handbook.updatedAt });
    });

  let rollouts: string[] = [];
  try {
    rollouts = (await readdir(join(dir, "rollout_summaries"))).filter((f) => f.endsWith(".md")).sort();
  } catch {}
  for (const f of rollouts) {
    const r = await read(join(dir, "rollout_summaries", f));
    if (!r) continue;
    const tag = /^cwd:\s*(.+)$/m.exec(r.text)?.[1];
    if (appliesTo(tag, cwd)) entries.push({ id: `rollout_summaries/${f}`, title: f.replace(/\.md$/, ""), ...r });
  }

  return entries.length ? { scope: "global", location: dir, entries } : null;
}

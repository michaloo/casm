// Claude Code's auto memory: <config dir>/projects/<encoded folder>/memory/,
// a MEMORY.md index (loaded into every session) plus one note file per memory,
// linked from the index as "- [Title](note.md) — hook".
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, type MemoryEntry } from "@casm/protocol";
import { RpcError } from "../agents.ts";
import type { ProviderMemories } from "./types.ts";

export const INDEX = "MEMORY.md";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Claude's project-dir name: every non-alphanumeric character becomes "-";
// names over 200 chars are cut and suffixed with a 32-bit string hash.
export function encodeProjectPath(path: string): string {
  const s = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

// Claude keys memory by the main checkout of the git repo containing `cwd`
// (worktrees share it), else by `cwd` itself.
export function memoryRoot(cwd: string): string {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const git = join(d, ".git");
    if (existsSync(git)) {
      try {
        if (statSync(git).isDirectory()) return d;
        // A worktree: ".git" is a file pointing at <main>/.git/worktrees/<name>.
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"));
        if (m) {
          const gitdir = resolve(d, m[1].trim());
          const i = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
          if (i >= 0) return gitdir.slice(0, i);
        }
      } catch {}
      return d;
    }
    if (dirname(d) === d) return resolve(cwd);
  }
}

// The user setting `autoMemoryDirectory` moves the store out of projects/.
function customDir(): string | null {
  try {
    const s = JSON.parse(readFileSync(join(claudeConfigDir(), "settings.json"), "utf8")) as { autoMemoryDirectory?: unknown };
    const d = s.autoMemoryDirectory;
    if (typeof d !== "string" || !d.trim()) return null;
    return d.startsWith("~/") ? join(homedir(), d.slice(2)) : isAbsolute(d) ? d : null;
  } catch {
    return null;
  }
}

export function memoryDir(cwd: string): { dir: string; scope: "project" | "global" } {
  const custom = customDir();
  if (custom) return { dir: custom, scope: "global" };
  return { dir: join(claudeConfigDir(), "projects", encodeProjectPath(memoryRoot(cwd)), "memory"), scope: "project" };
}

// "- [Title](file.md) — hook" lines of MEMORY.md, by file.
export function indexTitles(index: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of index.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) if (!out.has(m[2])) out.set(m[2], m[1]);
  return out;
}

function frontmatterName(text: string): string | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const name = fm && /^name:\s*(.+)$/m.exec(fm[1]);
  return name ? name[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

async function listNotes(dir: string, sub = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(dir, sub), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory() && !e.name.startsWith(".")) out.push(...(await listNotes(dir, rel)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

async function entry(dir: string, id: string, titles: Map<string, string>): Promise<MemoryEntry> {
  const file = join(dir, id);
  const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  const title = id === INDEX ? "Index (MEMORY.md)" : (titles.get(id) ?? frontmatterName(text));
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const description = fm && /^description:\s*(.+)$/m.exec(fm[1])?.[1].trim().replace(/^["']|["']$/g, "");
  return { id, ...(title ? { title } : {}), ...(description ? { description } : {}), text, updatedAt: st.mtime.toISOString() };
}

export async function claudeMemories(cwd: string): Promise<ProviderMemories | null> {
  const { dir, scope } = memoryDir(cwd);
  const files = await listNotes(dir);
  if (!files.length) return null;
  const titles = existsSync(join(dir, INDEX)) ? indexTitles(await readFile(join(dir, INDEX), "utf8")) : new Map<string, string>();
  // The index first, then notes in index order, then any unindexed notes.
  const order = [INDEX, ...titles.keys()];
  const rank = (f: string) => (order.indexOf(f) < 0 ? order.length : order.indexOf(f));
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { scope, location: dir, entries: await Promise.all(files.map((f) => entry(dir, f, titles))) };
}

// Resolves an entry id to a file inside the memory dir, or throws.
function notePath(dir: string, id: string): string {
  const file = resolve(dir, id);
  const rel = relative(dir, file);
  if (!id || isAbsolute(id) || rel.startsWith("..") || isAbsolute(rel) || !rel.endsWith(".md"))
    throw new RpcError(ErrorCode.InvalidParams, `invalid memory entry id "${id}"`);
  if (!existsSync(file)) throw new RpcError(ErrorCode.NotFound, `memory entry "${id}" not found`);
  return file;
}


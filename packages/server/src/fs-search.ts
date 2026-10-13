// File lookup for @-mentions. Lists files with ripgrep or git (both respect
// .gitignore), falling back to a shallow walk, then ranks matches.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_FILES = 50_000;
const SKIP = new Set([".git", "node_modules", ".venv", "dist", "build", ".next", "target"]);

async function listFiles(root: string): Promise<string[]> {
  for (const [cmd, args] of [
    ["rg", ["--files", "--hidden", "--glob", "!.git"]],
    ["git", ["ls-files", "--cached", "--others", "--exclude-standard"]],
  ] as const) {
    try {
      const { stdout } = await run(cmd, [...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      return stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
    } catch {
      // not installed, or not a git repo
    }
  }
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) out.push(relative(root, full));
    }
  };
  await walk(root, 0);
  return out;
}

// Lower is better: exact basename, basename prefix, basename substring, path
// substring, then in-order characters (fuzzy). Undefined = no match.
function score(path: string, q: string): number | undefined {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (!q) return p.split("/").length;
  if (base === q) return 0;
  if (base.startsWith(q)) return 1 + base.length / 1000;
  if (base.includes(q)) return 2 + base.length / 1000;
  if (p.includes(q)) return 3 + p.length / 1000;
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 4 + p.length / 1000 : undefined;
}

export async function searchFiles(root: string, query: string, limit = 50) {
  const files = await listFiles(root);
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  const q = query.toLowerCase().replace(/^@/, "");
  const ranked: { path: string; kind: "file" | "dir"; s: number }[] = [];
  for (const [list, kind] of [
    [files, "file"],
    [[...dirs], "dir"],
  ] as const) {
    for (const path of list) {
      const s = score(path, q);
      if (s !== undefined) ranked.push({ path, kind, s });
    }
  }
  ranked.sort((a, b) => a.s - b.s || a.path.localeCompare(b.path));
  return ranked.slice(0, limit).map(({ path, kind }) => ({ path, kind }));
}

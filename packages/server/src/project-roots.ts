import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

export function configuredProjectRoots(env = process.env): string[] | undefined {
  if (!env.CASM_PROJECT_ROOTS) return undefined;
  const roots: unknown = JSON.parse(env.CASM_PROJECT_ROOTS);
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === "string" && isAbsolute(root)))
    throw new Error("CASM_PROJECT_ROOTS must be a nonempty JSON array of absolute directories");
  return roots.map(root => resolve(root));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Resolve existing ancestors before mkdir, so a junction cannot lead outside a root.
function physical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(physical(parent), relative(parent, path));
  }
}

export function assertProjectPath(path: string, roots = configuredProjectRoots()): void {
  if (!roots) return;
  const absolute = resolve(path);
  if (!isAbsolute(path) || !roots.some(root => inside(root, absolute) && inside(realpathSync(root), physical(absolute))))
    throw new Error(`Choose a folder inside the configured project roots: ${roots.join("; ")}`);
}

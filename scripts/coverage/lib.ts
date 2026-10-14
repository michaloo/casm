// Shared helpers for the protocol-coverage scripts: inventory and
// classification file formats, paths, and small process utilities.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const COVERAGE_DIR = join(ROOT, "coverage");
export const INVENTORY_DIR = join(COVERAGE_DIR, "inventory");
// Temp files (schemas, npm tarballs) live here; never in the repo.
export const TMP_DIR = "/tmp/casm-coverage";

export const SOURCES = ["claude", "codex", "opencode", "pi", "acp"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_TITLES: Record<Source, string> = {
  claude: "Claude Code (Agent SDK)",
  codex: "Codex (app-server)",
  opencode: "OpenCode (serve)",
  pi: "pi (RPC mode)",
  acp: "ACP (Agent Client Protocol)",
};

export type InventoryEntry = { id: string; kind: string; note?: string };
export type Inventory = {
  source: Source;
  // Version of the agent (or package) the inventory was extracted from.
  version: string;
  // Where the ids came from, for humans.
  from: string;
  items: InventoryEntry[];
};

// Gap themes, used to group gaps in the report.
export const THEMES = {
  input: "Input content (images, files, mentions)",
  "tool-content": "Rich tool content (diffs, terminals, streaming output)",
  output: "Rich assistant output (images, files, citations)",
  plan: "Plans and todos",
  usage: "Usage, cost and context window",
  session: "Session control (fork, rewind, compact, rename, list)",
  config: "Live config changes (model, mode, effort mid-session)",
  "agent-extras": "Agent extras (commands, skills, MCP, hooks, subagents)",
  status: "Status, retries, warnings and errors",
  interaction: "Interaction (permissions, questions, dialogs)",
} as const;
export type Theme = keyof typeof THEMES;

export type Classification =
  | { status: "mapped"; to: string; note?: string }
  | { status: "ignored"; reason: string }
  | { status: "gap"; theme: Theme; note: string };
export type ClassificationFile = {
  source: Source;
  // How "mapped" is meant for this source.
  description?: string;
  items: Record<string, Classification>;
};

export function inventoryPath(source: Source) {
  return join(INVENTORY_DIR, `${source}.json`);
}

export function classificationPath(source: Source) {
  return join(COVERAGE_DIR, `${source}.json`);
}

// Sorted, de-duplicated by id (the first note wins).
export function finish(inv: Inventory): Inventory {
  const byId = new Map<string, InventoryEntry>();
  for (const e of inv.items) if (!byId.has(e.id)) byId.set(e.id, e);
  const items = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...inv, items };
}

export function writeInventory(inv: Inventory) {
  mkdirSync(INVENTORY_DIR, { recursive: true });
  const out = finish(inv);
  // One entry per line keeps diffs readable after an agent upgrade.
  const lines = out.items.map((e) => "    " + JSON.stringify(e));
  const text =
    `{\n  "source": ${JSON.stringify(out.source)},\n  "version": ${JSON.stringify(out.version)},\n` +
    `  "from": ${JSON.stringify(out.from)},\n  "items": [\n${lines.join(",\n")}\n  ]\n}\n`;
  writeFileSync(inventoryPath(out.source), text);
  return out;
}

export function readInventory(source: Source): Inventory | null {
  const p = inventoryPath(source);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Inventory) : null;
}

export function readClassification(source: Source): ClassificationFile | null {
  const p = classificationPath(source);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ClassificationFile) : null;
}

// Absolute path of an executable on PATH, or null.
export function which(bin: string): string | null {
  try {
    const p = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return p || null;
  } catch {
    return null;
  }
}

export function run(bin: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout ?? 60_000, cwd: opts.cwd });
}

// Walks up from a file to the nearest package.json whose name matches.
export function packageRoot(file: string, name: RegExp): string | null {
  let dir = dirname(realpathSync(file));
  while (dir !== dirname(dir)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if (name.test(JSON.parse(readFileSync(pj, "utf8")).name)) return dir;
      } catch {}
    }
    dir = dirname(dir);
  }
  return null;
}

// `node scripts/coverage/<source>.ts` writes that source's inventory.
export async function mainExtract(extract: () => Promise<Inventory | null>, source: Source) {
  const inv = await extract();
  if (!inv) {
    console.error(`${source}: not available on this host; keeping the checked-in inventory`);
    process.exitCode = 1;
    return;
  }
  const out = writeInventory(inv);
  console.log(`${source}: ${out.items.length} ids from ${out.from} (${out.version})`);
}

// `npm run coverage`: re-extracts every inventory from the installed agents
// (and the published ACP schema), then writes coverage/REPORT.md.
//   node scripts/coverage/run.ts [--offline] [source...]
// --offline skips the npm download for ACP (the /tmp cache is used if present).
// A source whose agent isn't installed keeps its checked-in inventory.
// Exits 1 when an id is unclassified, a classification is stale, or one is malformed.
import { check } from "./check.ts";
import { SOURCES, readClassification, readInventory, writeInventory, type Inventory, type Source } from "./lib.ts";
import { writeReport } from "./report.ts";
import { extract as claude } from "./claude.ts";
import { extract as codex } from "./codex.ts";
import { extract as pi } from "./pi.ts";
import { extract as acp } from "./acp.ts";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const only = args.filter((a) => !a.startsWith("--")) as Source[];
for (const s of only) if (!SOURCES.includes(s)) throw new Error(`unknown source ${s}; use ${SOURCES.join(", ")}`);

const extractors: Record<Source, () => Promise<Inventory | null>> = {
  claude,
  codex,
  pi,
  acp: () => acp({ offline }),
};

for (const source of only.length ? only : SOURCES) {
  const before = readInventory(source);
  let inv: Inventory | null;
  try {
    inv = await extractors[source]();
  } catch (e) {
    console.error(`${source}: extraction failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    continue;
  }
  if (!inv) {
    console.log(`${source}: not available here; keeping the checked-in inventory${before ? ` (${before.version})` : ""}`);
    continue;
  }
  const out = writeInventory(inv);
  const old = new Set(before?.items.map((i) => i.id) ?? []);
  const now = new Set(out.items.map((i) => i.id));
  const added = [...now].filter((id) => !old.has(id));
  const removed = [...old].filter((id) => !now.has(id));
  const delta = before ? ` (+${added.length} / -${removed.length} since ${before.version})` : "";
  console.log(`${source}: ${out.items.length} ids, ${out.version}${delta}`);
}

const { problems } = writeReport();
for (const source of SOURCES) {
  const inv = readInventory(source);
  if (!inv) continue;
  const r = check(inv, readClassification(source));
  for (const id of r.unclassified) console.log(`  ${source}: unclassified ${id}`);
  for (const id of r.stale) console.log(`  ${source}: no longer in the inventory: ${id}`);
  for (const e of r.invalid) console.log(`  ${source}: ${e}`);
}
console.log(`wrote coverage/REPORT.md${problems.length ? "; classify the ids above in coverage/<source>.json" : ""}`);
if (problems.length) process.exitCode = 1;

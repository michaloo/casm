// Protocol coverage drift check (see coverage/REPORT.md and scripts/coverage/).
// Every id in each agent's inventory must be classified in coverage/<source>.json,
// and every classification must still name an id in the inventory.
// Inventories are re-extracted here when that is cheap and the agent is
// installed (Claude SDK types, Codex schema, pi docs, ACP from the /tmp
// cache).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../../scripts/coverage/check.ts";
import { COVERAGE_DIR, SOURCES, finish, readClassification, readInventory, type Inventory, type Source } from "../../../scripts/coverage/lib.ts";
import { buildReport } from "../../../scripts/coverage/report.ts";
import { extract as claude } from "../../../scripts/coverage/claude.ts";
import { extract as codex } from "../../../scripts/coverage/codex.ts";
import { extract as pi } from "../../../scripts/coverage/pi.ts";
import { acpVersionCmp, cachedTarball, extractFromTarball } from "../../../scripts/coverage/acp.ts";

const FIX = 'run "npm run coverage" and classify the ids in coverage/<source>.json';

function acpFromCache(checkedIn: Inventory | null): Inventory | null {
  const tar = cachedTarball();
  const version = checkedIn?.version.split(" ").pop() ?? "0";
  return tar && acpVersionCmp(tar.version, version) >= 0 ? extractFromTarball(tar.file, tar.version) : null;
}

const fresh: Partial<Record<Source, (checkedIn: Inventory | null) => Promise<Inventory | null>>> = {
  claude: () => claude(),
  codex: () => codex(),
  pi: () => pi(),
  acp: async (checkedIn) => acpFromCache(checkedIn),
};

for (const source of SOURCES) {
  test(`coverage: every ${source} protocol id is classified`, async (t) => {
    const checkedIn = readInventory(source);
    const extracted = (await fresh[source]?.(checkedIn)) ?? null;
    const live = extracted && finish(extracted);
    const inv = live ?? checkedIn;
    assert.ok(inv, `coverage/inventory/${source}.json is missing; ${FIX}`);
    if (!live) t.diagnostic(`using the checked-in inventory (${inv.version})`);

    const { unclassified, stale, invalid } = check(inv, readClassification(source));
    assert.deepEqual(
      { unclassified, stale, invalid },
      { unclassified: [], stale: [], invalid: [] },
      `${source} ${inv.version}: classify new ids, drop ids it no longer has, fix malformed entries; ${FIX}`,
    );

    if (live && checkedIn) {
      const ids = (i: Inventory) => i.items.map((x) => x.id);
      assert.deepEqual(ids(checkedIn), ids(live), `coverage/inventory/${source}.json is out of date (installed: ${live.version}); ${FIX}`);
    }
  });
}

test("coverage: REPORT.md is up to date", () => {
  const current = readFileSync(join(COVERAGE_DIR, "REPORT.md"), "utf8");
  assert.equal(current, buildReport().markdown, 'run "npm run coverage" (or node scripts/coverage/report.ts)');
});

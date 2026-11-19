import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hostAgentsMd, setHostAgentsMd } from "../src/host-details.ts";

test("Claude import and Codex global instructions share one editor and preserve the wrapper", async () => {
  const home = await mkdtemp(join(tmpdir(), "casm shared instructions "));
  const codex = join(home, ".codex", "AGENTS.md");
  const claude = join(home, ".claude", "CLAUDE.md");
  const options = { home, env: {}, providers: ["claude", "codex"] as ("claude" | "codex")[] };
  try {
    await mkdir(dirname(codex)); await mkdir(dirname(claude));
    await writeFile(codex, "Shared preferences");
    await writeFile(claude, "@../.codex/AGENTS.md\n");
    const files = await hostAgentsMd(options);
    assert.equal(files.length, 1);
    assert.deepEqual(files[0].sources.map(s => s.provider), ["claude", "codex"]);
    assert.equal(files[0].path, codex);
    await setHostAgentsMd(files[0].path, "Updated preferences", files[0].sha256, options);
    assert.equal(await readFile(codex, "utf8"), "Updated preferences");
    assert.equal(await readFile(claude, "utf8"), "@../.codex/AGENTS.md\n");
    await assert.rejects(setHostAgentsMd(join(home, "unrelated.md"), "no", null, options));
    await writeFile(claude, "Local instructions\n@../.codex/AGENTS.md\n");
    assert.equal((await hostAgentsMd(options)).length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

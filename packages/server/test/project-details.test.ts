// AGENTS.md and per-agent memories, against fixture stores in a temp
// CLAUDE_CONFIG_DIR / CODEX_HOME.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";
import { claudeMemories, encodeProjectPath, memoryDir, memoryRoot } from "../src/providers/claude-memory.ts";
import { appliesTo, codexMemories, parseBlocks } from "../src/providers/codex-memory.ts";

const root = mkdtempSync(join(tmpdir(), "casm-details-"));
const claudeHome = join(root, "claude");
const codexHome = join(root, "codex");
const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.CODEX_HOME = codexHome;
after(() => {
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

// A project folder "my_app.v2" (dots and underscores encode to "-").
const project = join(root, "work", "my_app.v2");
mkdirSync(project, { recursive: true });

function claudeFixture(): string {
  const dir = join(claudeHome, "projects", encodeProjectPath(project), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "MEMORY.md"),
    "- [Branch names](branches.md) — feat/<ticket>-<slug>\n- [Deploy](deploy.md) — fly deploy from main\n",
  );
  writeFileSync(join(dir, "branches.md"), "---\nname: branches\ndescription: branch naming\n---\n\nAlways feat/<ticket>-<slug>.\n");
  writeFileSync(join(dir, "deploy.md"), "---\nname: deploy\n---\n\nfly deploy from main.\n");
  writeFileSync(join(dir, "loose.md"), "---\nname: loose-note\n---\n\nNot in the index.\n");
  return dir;
}

const HANDBOOK = `# Task Group: widgetd branch naming
scope: naming git branches in widgetd
applies_to: cwd=${project}; reuse_rule=only for this repo

## Task 1: suggest branch names
### keywords
- branch, feat/

## Reusable knowledge
- Branches are feat/<ticket>-<slug>.

# Task Group: other repo builds
scope: builds elsewhere
applies_to: cwd=/srv/other-repo; reuse_rule=checkout specific

## Reusable knowledge
- Use make.

# Task Group: general shell habits
scope: any repo
applies_to: cwd=unknown; reuse_rule=always safe

- Prefer rg.
`;

function codexFixture() {
  const dir = join(codexHome, "memories");
  mkdirSync(join(dir, "rollout_summaries"), { recursive: true });
  writeFileSync(join(dir, "memory_summary.md"), "v1\n## What's in Memory\n- widgetd branch naming\n");
  writeFileSync(join(dir, "MEMORY.md"), HANDBOOK);
  writeFileSync(join(dir, "raw_memories.md"), "# Raw Memories\n");
  writeFileSync(join(dir, "rollout_summaries", "widgetd-branches.md"), `thread_id: t1\nupdated_at: 2026-10-13\ncwd: ${project}\n\nThe user said branches are feat/<ticket>-<slug>.\n`);
  writeFileSync(join(dir, "rollout_summaries", "other.md"), "thread_id: t2\ncwd: /srv/other-repo\n\nmake things.\n");
}

test("claude: project dir encoding matches Claude Code", () => {
  assert.equal(encodeProjectPath("/home/michaloo/Explorations"), "-home-michaloo-Explorations");
  assert.equal(encodeProjectPath("/a/my_app.v2"), "-a-my-app-v2");
  const long = `/${"x".repeat(250)}`;
  assert.match(encodeProjectPath(long), /^-x{199}-[0-9a-z]+$/);
});

test("claude: memory is keyed by the main checkout of a git repo", () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(join(repo, "sub", "deeper"), { recursive: true });
  assert.equal(memoryRoot(join(repo, "sub", "deeper")), repo);
  const wt = join(root, "repo-wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  assert.equal(memoryRoot(wt), repo);
  assert.equal(memoryRoot(project), project);
  assert.equal(memoryDir(project).dir, join(claudeHome, "projects", encodeProjectPath(project), "memory"));
});

test("claude: lists the index, then notes in index order, titled from the index", async () => {
  assert.equal(await claudeMemories(join(root, "nothing-here")), null);
  const dir = claudeFixture();
  const m = (await claudeMemories(project))!;
  assert.equal(m.entries.find((e) => e.id === "branches.md")?.description, "branch naming");
  assert.equal(m.scope, "project");
  assert.equal(m.location, dir);
  assert.deepEqual(
    m.entries.map((e) => [e.id, e.title]),
    [
      ["MEMORY.md", "Index (MEMORY.md)"],
      ["branches.md", "Branch names"],
      ["deploy.md", "Deploy"],
      ["loose.md", "loose-note"],
    ],
  );
  assert.match(m.entries[1].text, /Always feat/);
  assert.ok(m.entries[1].updatedAt);
});

test("claude: autoMemoryDirectory moves the store and makes it global", async () => {
  const custom = join(root, "custom-memory");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "MEMORY.md"), "- [x](x.md)\n");
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ autoMemoryDirectory: custom }));
  try {
    const m = (await claudeMemories(project))!;
    assert.equal(m.scope, "global");
    assert.equal(m.location, custom);
  } finally {
    writeFileSync(join(claudeHome, "settings.json"), "{}");
  }
});

test("codex: cwd tags decide which handbook blocks apply", () => {
  assert.equal(appliesTo(`cwd=${project}`.slice(4), project), true);
  assert.equal(appliesTo(join(project, "sub"), project), true);
  assert.equal(appliesTo(join(root, "work"), project), true);
  assert.equal(appliesTo("/srv/other-repo", project), false);
  assert.equal(appliesTo("unknown", project), true);
  assert.equal(appliesTo(`${project} and /srv/x`, project), true);
  assert.equal(appliesTo(`${project}-other`, project), false);
  const blocks = parseBlocks(HANDBOOK);
  assert.deepEqual(
    blocks.map((b) => [b.title, b.cwd]),
    [
      ["widgetd branch naming", project],
      ["other repo builds", "/srv/other-repo"],
      ["general shell habits", "unknown"],
    ],
  );
});

test("codex: global store filtered to the project", async () => {
  assert.equal(await codexMemories(project), null);
  codexFixture();
  const m = (await codexMemories(project))!;
  assert.equal(m.scope, "global");
  assert.equal(m.entries.find((e) => e.id === "MEMORY.md#1")?.description, "naming git branches in widgetd");
  assert.deepEqual(
    m.entries.map((e) => [e.id, e.title]),
    [
      ["memory_summary.md", "Summary (loaded into every session)"],
      ["MEMORY.md#1", "widgetd branch naming"],
      ["MEMORY.md#3", "general shell habits"],
      ["rollout_summaries/widgetd-branches.md", "widgetd-branches"],
    ],
  );
});

// --- over the wire

let server: RunningServer;
let client: CasmClient;
let store: Store;

const memoryProvider = (id: "claude" | "codex", extra: Partial<Provider>): Provider => ({
  id,
  open: () => {
    throw new Error("not used");
  },
  history: async () => [],
  usage: async () => null,
  commands: async () => [],
  catalog: async () => ({ models: [], modes: [] }),
  ...extra,
});

before(async () => {
  store = new Store(join(mkdtempSync(join(tmpdir(), "casm-test-")), "casm.db"));
  const token = store.createToken("test");
  const providers = [
    memoryProvider("claude", { memories: claudeMemories }),
    memoryProvider("codex", { memories: codexMemories }),
  ];
  server = await startServer({ store, providers, host: "127.0.0.1", port: 0, version: "test" });
  client = await CasmClient.connect(`ws://127.0.0.1:${server.port}`, token);
});

after(async () => {
  client.close();
  await server.close();
  store.close();
});

test("project.agentsMd reads and writes <project>/AGENTS.md", async () => {
  const p = await client.call("project.create", { path: project });
  assert.deepEqual(await client.call("project.agentsMd", { id: p.id }), { path: join(project, "AGENTS.md"), content: null, sha256: null });
  const saved = await client.call("project.setAgentsMd", { id: p.id, content: "# Rules\n- be brief\n" });
  assert.equal(saved.path, join(project, "AGENTS.md"));
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "# Rules\n- be brief\n");
  assert.equal((await client.call("project.agentsMd", { id: p.id })).content, "# Rules\n- be brief\n");
});

test("project.memories lists each agent's store, read-only", async () => {
  claudeFixture();
  codexFixture();
  const p = await client.call("project.create", { path: project, name: "memories" });
  const { agents } = await client.call("project.memories", { id: p.id });
  assert.deepEqual(
    agents.map((a) => [a.provider, a.scope]),
    [
      ["claude", "project"],
      ["codex", "global"],
    ],
  );
  await assert.rejects(client.call("project.updateMemory" as "project.memories", { id: p.id }), (err: CasmError) => err.code === -32601);
});


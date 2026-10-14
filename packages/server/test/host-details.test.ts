import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import { ErrorCode } from "@casm/protocol";
import { hostAgentsMd, setHostAgentsMd } from "../src/host-details.ts";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";

const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "casm-host-details-")); roots.push(home);
  const paths = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".pi/agent/AGENTS.md"].map((path) => join(home, path));
  return { home, paths, options: { home, env: {} } };
}
after(async () => { await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))); });

test("global instruction symlinks deduplicate by target; atomic saves preserve aliases and file mode", async () => {
  const { home, paths, options } = await fixture();
  const target = join(home, "shared", "AGENTS.md");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "# Shared rules", { mode: 0o600 });
  for (const path of paths) { await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }
  const files = await hostAgentsMd(options);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, target);
  assert.deepEqual(files[0].sources.map((s) => s.provider), ["claude", "codex", "pi"]);
  const saved = await setHostAgentsMd(target, "# Updated", files[0].sha256, options);
  assert.equal(saved.content, "# Updated");
  assert.notEqual(saved.sha256, files[0].sha256);
  for (const path of paths) { assert.ok((await lstat(path)).isSymbolicLink()); assert.equal(await readFile(path, "utf8"), "# Updated"); }
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("missing global files and dangling targets are created without replacing symlinks", async () => {
  const { home, paths, options } = await fixture();
  let files = await hostAgentsMd(options);
  assert.equal(files.length, 3);
  assert.ok(files.every((file) => file.content === null && file.sha256 === null));
  await mkdir(dirname(paths[0]), { recursive: true });
  const target = join(home, "not-created", "AGENTS.md");
  await symlink(target, paths[0]);
  files = await hostAgentsMd(options);
  assert.equal(files[0].path, target);
  await setHostAgentsMd(target, "new file", null, options);
  assert.ok((await lstat(paths[0])).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), "new file");
});

test("version conflicts reject stale and concurrent saves; unknown paths are not writable", async () => {
  const { paths, options, home } = await fixture();
  await mkdir(dirname(paths[1]), { recursive: true });
  await writeFile(paths[1], "original");
  const file = (await hostAgentsMd(options)).find((f) => f.path === paths[1])!;
  const results = await Promise.allSettled([
    setHostAgentsMd(file.path, "one", file.sha256, options),
    setHostAgentsMd(file.path, "two", file.sha256, options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(failure.reason.code, ErrorCode.Conflict);
  await assert.rejects(setHostAgentsMd(file.path, "stale", file.sha256, options), { code: ErrorCode.Conflict });
  await assert.rejects(setHostAgentsMd(join(home, "arbitrary.md"), "no", null, options), { code: ErrorCode.NotFound });
  assert.deepEqual(await readdir(dirname(file.path)), ["AGENTS.md"]);
});

test("provider overrides, fallback files and configured homes select the actual global instructions", async () => {
  const { paths, options, home } = await fixture();
  for (const path of paths) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "base"); }
  const override = join(dirname(paths[1]), "AGENTS.override.md");
  await writeFile(override, "override");
  await writeFile(join(dirname(paths[2]), "AGENTS.override.md"), "pi override");
  let files = await hostAgentsMd(options);
  assert.ok(files.find((f) => f.path === override)?.sources.some((s) => s.provider === "codex"));
  assert.equal(files.find((f) => f.sources.some((s) => s.provider === "pi"))?.content, "pi override");
  await writeFile(override, " \n");
  files = await hostAgentsMd(options);
  assert.equal(files.find((f) => f.sources.some((s) => s.provider === "codex"))?.path, paths[1]);
  const custom = join(home, "custom-codex");
  files = await hostAgentsMd({ home, env: { CODEX_HOME: custom } });
  assert.ok(files.find((f) => f.path === join(custom, "AGENTS.md")));
});

test("host instruction RPCs route through peers and require SHA preconditions", async () => {
  const { home, paths } = await fixture();
  const changes = { CLAUDE_CONFIG_DIR: dirname(paths[0]), CODEX_HOME: dirname(paths[1]), PI_CODING_AGENT_DIR: dirname(paths[2]) };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const store = new Store(join(home, "test.db"));
  const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test" });
  const relayStore = new Store(join(home, "relay.db"));
  relayStore.setPeer({ name: "settings-peer", url: server.url, token: store.createToken("peer"), serverId: null });
  const relay = await startServer({ store: relayStore, providers: [], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(relay.url, relayStore.createToken("test"), { host: "settings-peer" });
  try {
    const { files } = await client.call("host.agentsMd", {});
    assert.equal(files.length, 3);
    const saved = await client.call("host.setAgentsMd", { path: files[0].path, content: "saved over RPC", expectedSha256: null });
    assert.equal(saved.content, "saved over RPC");
    await assert.rejects(client.call("host.setAgentsMd", { path: files[0].path, content: "stale", expectedSha256: null }), (e: CasmError) => e.code === ErrorCode.Conflict);
  } finally {
    client.close(); await relay.close(); relayStore.close(); await server.close(); store.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

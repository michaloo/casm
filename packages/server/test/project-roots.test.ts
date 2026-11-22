import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredProjectRoots, assertProjectPath } from "../src/project-roots.ts";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { CasmClient } from "@casm/client";

test("configured project roots reject siblings, traversal and junction escapes before creating folders", async () => {
  const temp = mkdtempSync(join(tmpdir(), "casm roots "));
  const allowed = join(temp, "allowed"), outside = join(temp, "outside");
  mkdirSync(allowed); mkdirSync(outside);
  const previous = process.env.CASM_PROJECT_ROOTS;
  const store = new Store(join(temp, "casm.db"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let client: CasmClient | undefined;
  try {
    symlinkSync(outside, join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
    process.env.CASM_PROJECT_ROOTS = JSON.stringify([allowed]);
    assert.deepEqual(configuredProjectRoots(), [allowed]);
    assert.doesNotThrow(() => assertProjectPath(join(allowed, "new", "project")));
    for (const path of [outside, join(allowed, "..", "outside"), join(allowed, "escape", "new")])
      assert.throws(() => assertProjectPath(path), /configured project roots/);
    assert.throws(() => configuredProjectRoots({ CASM_PROJECT_ROOTS: "[]" }));
    assert.throws(() => configuredProjectRoots({ CASM_PROJECT_ROOTS: '["relative"]' }));
    server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test", home: temp });
    client = await CasmClient.connect(server.url, store.createToken("test"));
    assert.deepEqual((await client.call("server.info", {})).projectRoots, [allowed]);
    const blocked = join(outside, "must-not-exist");
    await assert.rejects(client.call("project.create", { path: blocked, createFolder: true }), /configured project roots/);
    assert.equal(existsSync(blocked), false);
    await assert.rejects(client.call("fs.search", { cwd: outside, query: "" }), /configured project roots/);
    await assert.rejects(client.call("fs.list", { path: outside }), /not inside a project folder/);
    await assert.rejects(client.call("fs.read", { path: join(outside, "file.txt") }), /not inside a project folder/);
    await assert.rejects(client.call("fs.downloadLink", { path: join(outside, "file.txt") }), /not inside a project folder/);
    const legacy = store.createProject({ path: outside, name: "legacy outside root" });
    await assert.rejects(client.call("project.agentsMd", { id: legacy.id }), /configured project roots/);
    const created = await client.call("project.create", { path: join(allowed, "new"), createFolder: true });
    assert.equal(created.path, join(allowed, "new"));
  } finally {
    client?.close(); await server?.close(); store.close();
    if (previous === undefined) delete process.env.CASM_PROJECT_ROOTS; else process.env.CASM_PROJECT_ROOTS = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

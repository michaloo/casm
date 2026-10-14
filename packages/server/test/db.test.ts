import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.ts";

test("nested projects migrate to grouped folders and keep their agents", () => {
  const file = join(mkdtempSync(join(tmpdir(), "casm-db-")), "casm.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT, tags TEXT NOT NULL DEFAULT '[]', sort REAL NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      provider TEXT NOT NULL, cwd TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', native_session_id TEXT, parent TEXT,
      tags TEXT NOT NULL DEFAULT '[]', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO projects (id, name, parent_id, path, created_at) VALUES ('w', 'Work', NULL, '/work', 't'), ('a', 'App', 'w', NULL, 't');
    INSERT INTO agents (id, project_id, name, provider, cwd, created_at, updated_at) VALUES ('x', 'a', 'agent', 'claude', '/work', 't', 't');
  `);
  old.close();

  const store = new Store(file);
  const app = store.getProject("a")!;
  assert.equal(app.path, "/work");
  assert.equal(app.group, "Work");
  assert.equal(store.getProject("w")!.group, null);
  assert.equal(store.getAgent("x")!.projectId, "a");
  // Columns added later appear on old tables.
  assert.equal(store.getAgent("x")!.effectiveModel, null);
  assert.equal(store.updateAgent("x", { effectiveModel: "gpt-6-astra" })!.effectiveModel, "gpt-6-astra");
  store.close();
  new Store(file).close(); // migrating twice is a no-op
});

test("time-based pending messages become one-off schedules", () => {
  const file = join(mkdtempSync(join(tmpdir(), "casm-db-")), "casm.db");
  const s1 = new Store(file);
  const p = s1.createProject({ name: "p", path: "/tmp" });
  const a = s1.createAgent({ projectId: p.id, name: "a", provider: "claude", cwd: "/tmp", config: {} });
  s1.db
    .prepare("INSERT INTO pending (id, agent_id, seq, text, reason, not_before, created_at) VALUES ('m', ?, 0, 'later', 'scheduled', '2030-01-01T00:00:00.000Z', 't')")
    .run(a.id);
  s1.close();
  const s2 = new Store(file);
  assert.deepEqual(s2.listPending(a.id), []);
  const [x] = s2.listSchedules();
  assert.deepEqual([x.cadence, x.target, x.prompt], [{ type: "once", at: "2030-01-01T00:00:00.000Z" }, { type: "agent", agentId: a.id }, "later"]);
  s2.close();
});

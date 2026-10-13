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
  store.close();
  new Store(file).close(); // migrating twice is a no-op
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.ts";

// The schema at 800edae (deployed 2026-10-13), the oldest database still in
// use. Copied verbatim; columns added after it are migrated by Store.
const SCHEMA_800EDAE = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  group_name TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  sort REAL NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  native_session_id TEXT,
  parent TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence TEXT NOT NULL,
  target TEXT NOT NULL,
  prompt TEXT NOT NULL,
  next_run_at TEXT,
  last_run TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq REAL NOT NULL,
  text TEXT NOT NULL,
  images TEXT,
  reason TEXT NOT NULL,
  not_before TEXT,
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
DROP TABLE IF EXISTS deferred;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peers (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  token TEXT NOT NULL,
  server_id TEXT,
  created_at TEXT NOT NULL
);
`;

const tempDb = () => join(mkdtempSync(join(tmpdir(), "casm-db-")), "casm.db");

// Every table's columns, as SQLite reports them.
function shape(file: string) {
  const db = new DatabaseSync(file);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const out = Object.fromEntries(
    tables.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => [c.name, c.type, c.notnull, c.pk]).sort()]),
  );
  db.close();
  return out;
}

test("a fresh database gets the current schema and works", () => {
  const file = tempDb();
  const store = new Store(file);
  const p = store.createProject({ name: "p", path: "/tmp" });
  const a = store.createAgent({ projectId: p.id, name: "a", provider: "claude", cwd: "/tmp", config: {} });
  assert.equal(store.updateAgent(a.id, { effectiveModel: "m" })!.effectiveModel, "m");
  store.addPending({ agentId: a.id, text: "x", reason: "failed", notBefore: null, note: "boom" });
  assert.equal(store.listPending(a.id)[0]!.reason, "failed");
  store.close();
  new Store(file).close();
});

test("a database at 800edae's schema opens, keeps its data and ends up like a fresh one", () => {
  const file = tempDb();
  const old = new DatabaseSync(file);
  old.exec(SCHEMA_800EDAE);
  old.exec(`
    INSERT INTO projects (id, name, path, group_name, created_at) VALUES ('p', 'Work', '/work', 'Clients', 't');
    INSERT INTO agents (id, project_id, name, provider, cwd, native_session_id, created_at, updated_at) VALUES ('x', 'p', 'agent', 'claude', '/work', 'n1', 't', 't');
    INSERT INTO pending (id, agent_id, seq, text, reason, created_at) VALUES ('m', 'x', 0, 'queued one', 'queued', 't');
    INSERT INTO schedules (id, name, cadence, target, prompt, created_at) VALUES ('s', 'daily', '{"type":"every","minutes":5}', '{"type":"agent","agentId":"x"}', 'go', 't');
  `);
  old.close();

  const store = new Store(file);
  assert.equal(store.getProject("p")!.group, "Clients");
  const agent = store.getAgent("x")!;
  assert.deepEqual([agent.projectId, agent.nativeSessionId, agent.effectiveModel], ["p", "n1", null]);
  assert.equal(store.updateAgent("x", { effectiveModel: "gpt-6-astra" })!.effectiveModel, "gpt-6-astra");
  assert.deepEqual(store.listPending("x").map((m) => m.text), ["queued one"]);
  assert.equal(store.listSchedules()[0]!.prompt, "go");
  store.close();
  new Store(file).close(); // opening again changes nothing

  const fresh = tempDb();
  new Store(fresh).close();
  assert.deepEqual(shape(file), shape(fresh));
});

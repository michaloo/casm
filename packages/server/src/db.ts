// The only persistent state: projects, agents (config + native session id),
// client tokens and peer servers. Transcripts live in each provider's own store.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { Agent, AgentConfig, AgentParent, ImageData, Project, ProviderId } from "@casm/protocol";

export type StoredAgent = Omit<Agent, "status" | "deferred" | "pending">;

export type PendingReason = "queued" | "limit" | "scheduled";

// A message waiting to be sent to an agent: behind a running turn ("queued"),
// until a usage limit resets ("limit"), or at a chosen time ("scheduled").
export type Pending = {
  id: string;
  agentId: string;
  seq: number;
  text: string;
  images?: ImageData[];
  reason: PendingReason;
  notBefore: string | null;
  note: string | null;
  attempts: number;
  createdAt: string;
};

function toPending(r: Row): Pending {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    seq: r.seq as number,
    text: r.text as string,
    images: r.images ? JSON.parse(r.images as string) : undefined,
    reason: r.reason as PendingReason,
    notBefore: (r.not_before as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    attempts: r.attempts as number,
    createdAt: r.created_at as string,
  };
}

const SCHEMA = `
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

// Another casm server. The token is ours to use on it (outbound), so it is
// stored in clear, unlike client tokens.
export type StoredPeer = { name: string; url: string; token: string; serverId: string | null; createdAt: string };

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    group: (r.group_name as string | null) ?? null,
    tags: JSON.parse(r.tags as string),
    sort: r.sort as number,
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toAgent(r: Row): StoredAgent {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    provider: r.provider as ProviderId,
    cwd: r.cwd as string,
    config: JSON.parse(r.config as string),
    nativeSessionId: (r.native_session_id as string | null) ?? null,
    parent: r.parent ? JSON.parse(r.parent as string) : null,
    tags: JSON.parse(r.tags as string),
    archivedAt: (r.archived_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    // node:sqlite enables foreign keys by default; the migration must run without them.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;");
    this.migrate();
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  // Projects used to nest (parent_id, optional path); now they are flat folders
  // with a group label. Rebuilt with foreign keys off so agents are kept.
  private migrate() {
    const cols = (this.db.prepare("PRAGMA table_info(projects)").all() as Row[]).map((c) => c.name);
    if (!cols.length || cols.includes("group_name")) return;
    this.db.exec(`
      BEGIN;
      CREATE TABLE projects_new (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, group_name TEXT,
        tags TEXT NOT NULL DEFAULT '[]', sort REAL NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO projects_new (id, name, path, group_name, tags, sort, archived_at, created_at)
        SELECT p.id, p.name, COALESCE(p.path, parent.path, '${homedir().replaceAll("'", "''")}'), parent.name, p.tags, p.sort, p.archived_at, p.created_at
        FROM projects p LEFT JOIN projects parent ON parent.id = p.parent_id;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      COMMIT;
    `);
  }

  close() {
    this.db.close();
  }

  // --- projects

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? "SELECT * FROM projects ORDER BY sort, name"
      : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY sort, name";
    return (this.db.prepare(sql).all() as Row[]).map(toProject);
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r && toProject(r);
  }

  createProject(p: { name: string; path: string; group?: string | null; tags?: string[] }): Project {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO projects (id, name, path, group_name, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.name, p.path, p.group || null, JSON.stringify(p.tags ?? []), now());
    return this.getProject(id)!;
  }

  updateProject(
    id: string,
    patch: { name?: string; path?: string; group?: string | null; tags?: string[]; sort?: number; archived?: boolean },
  ): Project | undefined {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name));
    if (patch.path !== undefined) (sets.push("path = ?"), vals.push(patch.path));
    if (patch.group !== undefined) (sets.push("group_name = ?"), vals.push(patch.group || null));
    if (patch.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(patch.tags)));
    if (patch.sort !== undefined) (sets.push("sort = ?"), vals.push(patch.sort));
    if (patch.archived !== undefined) (sets.push("archived_at = ?"), vals.push(patch.archived ? now() : null));
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // --- agents

  listAgents(opts: { projectId?: string; includeArchived?: boolean } = {}): StoredAgent[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (opts.projectId) (where.push("project_id = ?"), vals.push(opts.projectId));
    if (!opts.includeArchived) where.push("archived_at IS NULL");
    const sql = `SELECT * FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
    return (this.db.prepare(sql).all(...vals) as Row[]).map(toAgent);
  }

  getAgent(id: string): StoredAgent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return r && toAgent(r);
  }

  createAgent(a: {
    projectId: string;
    name: string;
    provider: ProviderId;
    cwd: string;
    config: AgentConfig;
    parent?: AgentParent | null;
    tags?: string[];
  }): StoredAgent {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, project_id, name, provider, cwd, config, parent, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        a.projectId,
        a.name,
        a.provider,
        a.cwd,
        JSON.stringify(a.config),
        a.parent ? JSON.stringify(a.parent) : null,
        JSON.stringify(a.tags ?? []),
        t,
        t,
      );
    return this.getAgent(id)!;
  }

  updateAgent(
    id: string,
    patch: {
      name?: string;
      projectId?: string;
      config?: AgentConfig;
      tags?: string[];
      archived?: boolean;
      nativeSessionId?: string | null;
    },
  ): StoredAgent | undefined {
    const sets: string[] = ["updated_at = ?"];
    const vals: (string | null)[] = [now()];
    if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name));
    if (patch.projectId !== undefined) (sets.push("project_id = ?"), vals.push(patch.projectId));
    if (patch.config !== undefined) (sets.push("config = ?"), vals.push(JSON.stringify(patch.config)));
    if (patch.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(patch.tags)));
    if (patch.archived !== undefined) (sets.push("archived_at = ?"), vals.push(patch.archived ? now() : null));
    if (patch.nativeSessionId !== undefined) (sets.push("native_session_id = ?"), vals.push(patch.nativeSessionId));
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }

  // --- pending messages, in send order (seq) per agent

  listPending(agentId?: string): Pending[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM pending WHERE agent_id = ? ORDER BY seq").all(agentId)
      : this.db.prepare("SELECT * FROM pending ORDER BY agent_id, seq").all();
    return (rows as Row[]).map(toPending);
  }

  addPending(p: Omit<Pending, "id" | "seq" | "createdAt" | "attempts"> & { attempts?: number; front?: boolean }): Pending {
    const id = randomUUID();
    const edge = this.db
      .prepare(`SELECT ${p.front ? "MIN(seq) - 1" : "MAX(seq) + 1"} AS s FROM pending WHERE agent_id = ?`)
      .get(p.agentId) as Row;
    this.db
      .prepare(
        "INSERT INTO pending (id, agent_id, seq, text, images, reason, not_before, note, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        p.agentId,
        (edge.s as number | null) ?? 0,
        p.text,
        p.images?.length ? JSON.stringify(p.images) : null,
        p.reason,
        p.notBefore,
        p.note,
        p.attempts ?? 0,
        now(),
      );
    return toPending(this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as Row);
  }

  removePending(id: string): boolean {
    return this.db.prepare("DELETE FROM pending WHERE id = ?").run(id).changes > 0;
  }

  // Removes an agent's pending messages, optionally only some reasons; returns how many.
  clearPending(agentId: string, reasons?: PendingReason[]): number {
    if (!reasons) return Number(this.db.prepare("DELETE FROM pending WHERE agent_id = ?").run(agentId).changes);
    const marks = reasons.map(() => "?").join(", ");
    return Number(this.db.prepare(`DELETE FROM pending WHERE agent_id = ? AND reason IN (${marks})`).run(agentId, ...reasons).changes);
  }

  // A stable id for this server, created on first use.
  serverId(): string {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'server_id'").get() as Row | undefined;
    if (r) return r.value as string;
    const id = randomUUID();
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('server_id', ?)").run(id);
    return id;
  }

  // --- tokens

  createToken(name: string): string {
    const token = "casm_" + randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO tokens (name, hash, created_at) VALUES (?, ?, ?)").run(name, hashToken(token), now());
    return token;
  }

  listTokens(): { name: string; createdAt: string }[] {
    return (this.db.prepare("SELECT name, created_at FROM tokens ORDER BY name").all() as Row[]).map((r) => ({
      name: r.name as string,
      createdAt: r.created_at as string,
    }));
  }

  revokeToken(name: string): boolean {
    return this.db.prepare("DELETE FROM tokens WHERE name = ?").run(name).changes > 0;
  }

  // Returns the token's name when valid.
  checkToken(token: string): string | undefined {
    const r = this.db.prepare("SELECT name FROM tokens WHERE hash = ?").get(hashToken(token)) as Row | undefined;
    return r?.name as string | undefined;
  }

  // --- peers

  setPeer(p: { name: string; url: string; token: string; serverId: string | null }) {
    this.db
      .prepare(
        `INSERT INTO peers (name, url, token, server_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET url = excluded.url, token = excluded.token, server_id = excluded.server_id`,
      )
      .run(p.name, p.url, p.token, p.serverId, now());
  }

  listPeers(): StoredPeer[] {
    return (this.db.prepare("SELECT * FROM peers ORDER BY name").all() as Row[]).map((r) => ({
      name: r.name as string,
      url: r.url as string,
      token: r.token as string,
      serverId: (r.server_id as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  removePeer(name: string): boolean {
    return this.db.prepare("DELETE FROM peers WHERE name = ?").run(name).changes > 0;
  }
}

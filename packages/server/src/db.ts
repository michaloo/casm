// The only persistent state: projects, agents (config + native session id) and
// client tokens. Transcripts live in each provider's own store.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Agent, AgentConfig, AgentParent, Project, ProviderId } from "@casm/protocol";

export type StoredAgent = Omit<Agent, "status">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT,
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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    parentId: (r.parent_id as string | null) ?? null,
    path: (r.path as string | null) ?? null,
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
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
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

  createProject(p: { name: string; parentId?: string | null; path?: string | null; tags?: string[] }): Project {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO projects (id, name, parent_id, path, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.name, p.parentId ?? null, p.path ?? null, JSON.stringify(p.tags ?? []), now());
    return this.getProject(id)!;
  }

  updateProject(
    id: string,
    patch: { name?: string; parentId?: string | null; path?: string | null; tags?: string[]; sort?: number; archived?: boolean },
  ): Project | undefined {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name));
    if (patch.parentId !== undefined) (sets.push("parent_id = ?"), vals.push(patch.parentId));
    if (patch.path !== undefined) (sets.push("path = ?"), vals.push(patch.path));
    if (patch.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(patch.tags)));
    if (patch.sort !== undefined) (sets.push("sort = ?"), vals.push(patch.sort));
    if (patch.archived !== undefined) (sets.push("archived_at = ?"), vals.push(patch.archived ? now() : null));
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  // The effective path: own path, else the nearest ancestor's.
  projectPath(id: string): string | null {
    for (let p = this.getProject(id); p; p = p.parentId ? this.getProject(p.parentId) : undefined) {
      if (p.path) return p.path;
    }
    return null;
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
}

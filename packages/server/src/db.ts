// The only persistent state: projects, agents (config + native session id),
// client tokens, peers and message sender metadata. Transcripts live in each provider's own store.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Agent, AgentConfig, AgentParent, MessageSender, ImageData, Project, ProviderId, Schedule } from "@casm/protocol";

export type StoredAgent = Omit<Agent, "status" | "deferred" | "pending">;

export type PendingReason = "queued" | "limit" | "failed";

// A message waiting for its agent: behind a running turn ("queued"), until a
// usage limit resets ("limit"), or kept after its turn failed early ("failed").
export type Pending = {
  id: string;
  agentId: string;
  seq: number;
  text: string;
  images?: ImageData[];
  sender?: MessageSender;
  reason: PendingReason;
  notBefore: string | null;
  note: string | null;
  attempts: number;
  createdAt: string;
};

function toSchedule(r: Row): Schedule {
  return {
    id: r.id as string,
    name: r.name as string,
    enabled: r.enabled === 1,
    cadence: JSON.parse(r.cadence as string),
    target: JSON.parse(r.target as string),
    prompt: r.prompt as string,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastRun: r.last_run ? JSON.parse(r.last_run as string) : null,
    createdAt: r.created_at as string,
  };
}

function toPending(r: Row): Pending {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    seq: r.seq as number,
    text: r.text as string,
    images: r.images ? JSON.parse(r.images as string) : undefined,
    sender: r.sender ? JSON.parse(r.sender as string) : undefined,
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
  effective_model TEXT,
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
CREATE TABLE IF NOT EXISTS message_senders (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  PRIMARY KEY (agent_id, item_id)
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
    effectiveModel: (r.effective_model as string | null) ?? null,
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
    // A fresh database gets the current schema; an existing one gets the
    // columns added since (databases older than 800edae are not supported).
    this.db.exec(SCHEMA);
    this.addColumn("agents", "effective_model", "TEXT");
    this.addColumn("pending", "sender", "TEXT");
  }

  // Columns added after release; CREATE TABLE IF NOT EXISTS leaves older tables as they were.
  private addColumn(table: string, column: string, type: string) {
    const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
    if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
      effectiveModel?: string | null;
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
    if (patch.effectiveModel !== undefined) (sets.push("effective_model = ?"), vals.push(patch.effectiveModel));
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }

  // --- schedules

  listSchedules(): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Row[]).map(toSchedule);
  }

  getSchedule(id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r && toSchedule(r);
  }

  saveSchedule(x: Schedule) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO schedules (id, name, enabled, cadence, target, prompt, next_run_at, last_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        x.id,
        x.name,
        x.enabled ? 1 : 0,
        JSON.stringify(x.cadence),
        JSON.stringify(x.target),
        x.prompt,
        x.nextRunAt,
        x.lastRun ? JSON.stringify(x.lastRun) : null,
        x.createdAt,
      );
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  // --- pending messages, in send order (seq) per agent

  listPending(agentId?: string): Pending[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM pending WHERE agent_id = ? ORDER BY seq").all(agentId)
      : this.db.prepare("SELECT * FROM pending ORDER BY agent_id, seq").all();
    return (rows as Row[]).map(toPending);
  }

  // Keeps `id` when given (a message put back keeps its identity), else makes one.
  addPending(p: Omit<Pending, "id" | "seq" | "createdAt" | "attempts"> & { id?: string; attempts?: number; front?: boolean }): Pending {
    const id = p.id ?? randomUUID();
    const edge = this.db
      .prepare(`SELECT ${p.front ? "MIN(seq) - 1" : "MAX(seq) + 1"} AS s FROM pending WHERE agent_id = ?`)
      .get(p.agentId) as Row;
    this.db
      .prepare(
        "INSERT INTO pending (id, agent_id, seq, text, images, sender, reason, not_before, note, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        p.agentId,
        (edge.s as number | null) ?? 0,
        p.text,
        p.images?.length ? JSON.stringify(p.images) : null,
        p.sender ? JSON.stringify(p.sender) : null,
        p.reason,
        p.notBefore,
        p.note,
        p.attempts ?? 0,
        now(),
      );
    return toPending(this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as Row);
  }

  saveMessageSender(agentId: string, itemId: string, sender: MessageSender) {
    this.db.prepare("INSERT OR REPLACE INTO message_senders (agent_id, item_id, sender) VALUES (?, ?, ?)").run(agentId, itemId, JSON.stringify(sender));
  }

  messageSender(agentId: string, itemId: string): MessageSender | undefined {
    const row = this.db.prepare("SELECT sender FROM message_senders WHERE agent_id = ? AND item_id = ?").get(agentId, itemId) as Row | undefined;
    return row ? JSON.parse(row.sender as string) : undefined;
  }

  // An authoritative healthy account refresh makes limit-deferred work due.
  releaseLimited(agentId: string): number {
    return Number(this.db.prepare("UPDATE pending SET reason = 'queued', not_before = NULL WHERE agent_id = ? AND reason = 'limit'").run(agentId).changes);
  }

  getPending(id: string): Pending | undefined {
    const row = this.db.prepare("SELECT * FROM pending WHERE id = ?").get(id) as Row | undefined;
    return row ? toPending(row) : undefined;
  }

  editPending(id: string, text: string): boolean {
    return this.db.prepare("UPDATE pending SET text = ? WHERE id = ?").run(text, id).changes > 0;
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

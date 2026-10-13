// Wire protocol shared by the casm server, the CLI and (via JSON Schema codegen) the Swift apps.
// JSON-RPC 2.0 over one WebSocket. Requests are listed in `methods`; server
// notifications in `notifications`.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Domain

export const ProviderId = z.enum(["claude", "codex", "pi", "opencode"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  path: z.string().nullable(),
  tags: z.array(z.string()),
  sort: z.number(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const AgentConfig = z.object({
  model: z.string().optional(),
  mode: z.string().optional(),
  effort: z.string().optional(),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const AgentParent = z.object({ host: z.string(), agentId: z.string() });
export type AgentParent = z.infer<typeof AgentParent>;

// Derived from the live process, never stored.
export const AgentStatus = z.enum(["idle", "running", "waiting"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Agent = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  provider: ProviderId,
  cwd: z.string(),
  config: AgentConfig,
  nativeSessionId: z.string().nullable(),
  parent: AgentParent.nullable(),
  tags: z.array(z.string()),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: AgentStatus,
});
export type Agent = z.infer<typeof Agent>;

// One normalized transcript entry. History and live events use the same shape;
// clients upsert by `id`.
export const Item = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("reasoning"), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: z.enum(["running", "done", "error"]),
    output: z.string().optional(),
  }),
  z.object({ kind: z.literal("notice"), id: z.string(), text: z.string() }),
]);
export type Item = z.infer<typeof Item>;

export const PermissionRequest = z.object({
  id: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  title: z.string().optional(),
  canAlwaysAllow: z.boolean(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionDecision = z.enum(["allow", "allowAlways", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const TurnOutcome = z.enum(["completed", "interrupted", "failed"]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

// Live events for one agent. `delta` streams text into a transient draft that
// the client drops when the next assistant/reasoning `item` arrives.
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turnStarted"), turnId: z.string() }),
  z.object({ type: z.literal("item"), item: Item }),
  z.object({ type: z.literal("delta"), kind: z.enum(["assistant", "reasoning"]), text: z.string() }),
  z.object({ type: z.literal("permission"), request: PermissionRequest }),
  z.object({ type: z.literal("permissionResolved"), requestId: z.string() }),
  z.object({
    type: z.literal("turnEnded"),
    turnId: z.string(),
    outcome: TurnOutcome,
    error: z.string().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

// ---------------------------------------------------------------------------
// Methods

const Empty = z.object({});
const ById = z.object({ id: z.string() });
const Ok = z.object({ ok: z.literal(true) });

function method<P extends z.ZodType, R extends z.ZodType>(params: P, result: R) {
  return { params, result };
}

export const methods = {
  "server.info": method(
    Empty,
    z.object({ name: z.string(), version: z.string(), protocol: z.number(), providers: z.array(ProviderId) }),
  ),

  "project.list": method(z.object({ includeArchived: z.boolean().optional() }), z.object({ projects: z.array(Project) })),
  "project.create": method(
    z.object({
      name: z.string().min(1),
      parentId: z.string().nullish(),
      path: z.string().nullish(),
      tags: z.array(z.string()).optional(),
    }),
    Project,
  ),
  "project.update": method(
    z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      parentId: z.string().nullish(),
      path: z.string().nullish(),
      tags: z.array(z.string()).optional(),
      sort: z.number().optional(),
      archived: z.boolean().optional(),
    }),
    Project,
  ),
  "project.delete": method(ById, Ok),

  "agent.list": method(
    z.object({ projectId: z.string().optional(), includeArchived: z.boolean().optional() }),
    z.object({ agents: z.array(Agent) }),
  ),
  "agent.get": method(ById, Agent),
  "agent.create": method(
    z.object({
      projectId: z.string(),
      provider: ProviderId,
      name: z.string().optional(),
      cwd: z.string().optional(),
      config: AgentConfig.optional(),
      parent: AgentParent.optional(),
      tags: z.array(z.string()).optional(),
      prompt: z.string().optional(),
    }),
    Agent,
  ),
  "agent.update": method(
    z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      projectId: z.string().optional(),
      config: AgentConfig.optional(),
      tags: z.array(z.string()).optional(),
      archived: z.boolean().optional(),
    }),
    Agent,
  ),
  "agent.delete": method(ById, Ok),
  // Reads the provider's native transcript. `before` is an item index from a
  // previous page; omitted means "the latest".
  "agent.history": method(
    z.object({ id: z.string(), before: z.number().optional(), limit: z.number().optional() }),
    z.object({ items: z.array(Item), start: z.number(), total: z.number() }),
  ),
  // Subscribe to live events. Returns the in-flight turn so a client that
  // connects mid-turn can catch up.
  "agent.subscribe": method(
    ById,
    z.object({ status: AgentStatus, turn: z.array(AgentEvent), permissions: z.array(PermissionRequest) }),
  ),
  "agent.unsubscribe": method(ById, Ok),
  // `queue` (default) runs after the current turn; `steer` injects into it.
  "agent.send": method(
    z.object({ id: z.string(), text: z.string().min(1), whenBusy: z.enum(["queue", "steer"]).optional() }),
    z.object({ queued: z.boolean() }),
  ),
  "agent.interrupt": method(ById, Ok),
  // Reload: new process, same native session. Restart: next turn starts a new session.
  "agent.reload": method(ById, Ok),
  "agent.restart": method(ById, Ok),
  "agent.respondPermission": method(
    z.object({ id: z.string(), requestId: z.string(), decision: PermissionDecision, message: z.string().optional() }),
    Ok,
  ),
  // Resolves when the agent is idle (or waiting for permission) or the timeout passes.
  "agent.wait": method(
    z.object({ id: z.string(), timeoutMs: z.number().optional() }),
    z.object({ status: AgentStatus, timedOut: z.boolean(), lastReply: z.string().nullable() }),
  ),
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = z.input<Methods[M]["params"]>;
export type Result<M extends MethodName> = z.infer<Methods[M]["result"]>;

export const notifications = {
  "agent.event": z.object({ agentId: z.string(), event: AgentEvent }),
  "agent.status": z.object({ agentId: z.string(), status: AgentStatus }),
  "agent.changed": z.object({ agent: Agent }),
  "agent.removed": z.object({ agentId: z.string() }),
  "project.changed": z.object({ project: Project }),
  "project.removed": z.object({ projectId: z.string() }),
} as const;

export type Notifications = typeof notifications;
export type NotificationName = keyof Notifications;
export type NotificationParams<N extends NotificationName> = z.infer<Notifications[N]>;

// ---------------------------------------------------------------------------
// JSON-RPC envelope

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  NotFound: 1001,
  Busy: 1002,
  Conflict: 1003,
} as const;

export type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params: unknown };

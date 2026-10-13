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

// A question the agent asks the user (Claude AskUserQuestion, Codex
// requestUserInput, pi dialogs, OpenCode questions). One request can hold
// several prompts; the answer maps prompt id -> value.
export const QuestionPrompt = z.object({
  id: z.string(),
  text: z.string(),
  header: z.string().optional(),
  kind: z.enum(["select", "text", "confirm"]),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  // select: allow picking several options.
  multiple: z.boolean().optional(),
  // select: allow a free-text answer instead of the options.
  allowOther: z.boolean().optional(),
  // text: multi-line input (editor) and an optional prefill.
  multiline: z.boolean().optional(),
  placeholder: z.string().optional(),
  // text: mask the input (passwords, tokens).
  secret: z.boolean().optional(),
});
export type QuestionPrompt = z.infer<typeof QuestionPrompt>;

export const QuestionRequest = z.object({
  id: z.string(),
  title: z.string().optional(),
  prompts: z.array(QuestionPrompt).min(1),
});
export type QuestionRequest = z.infer<typeof QuestionRequest>;

// select: option label(s) or free text; text: the text; confirm: boolean.
export const AnswerValue = z.union([z.string(), z.array(z.string()), z.boolean()]);
export type AnswerValue = z.infer<typeof AnswerValue>;
export const Answers = z.record(z.string(), AnswerValue);
export type Answers = z.infer<typeof Answers>;

export const ModelInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  // Reasoning effort levels this model accepts (AgentConfig.effort).
  efforts: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ModeInfo = z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional() });
export type ModeInfo = z.infer<typeof ModeInfo>;

export const Catalog = z.object({ models: z.array(ModelInfo), modes: z.array(ModeInfo) });
export type Catalog = z.infer<typeof Catalog>;

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
  z.object({ type: z.literal("question"), request: QuestionRequest }),
  z.object({ type: z.literal("questionResolved"), requestId: z.string() }),
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

  // Models and modes the agent offers on this host. Cached; `refresh` re-reads.
  "provider.catalog": method(z.object({ provider: ProviderId, refresh: z.boolean().optional() }), Catalog),

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
  // `config` fields merge into the current config ("" clears one) and apply
  // when the session is next opened: right away if idle, else after the turn.
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
    z.object({
      status: AgentStatus,
      turn: z.array(AgentEvent),
      permissions: z.array(PermissionRequest),
      questions: z.array(QuestionRequest),
    }),
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
  // Omit `answers` to dismiss the question.
  "agent.answerQuestion": method(z.object({ id: z.string(), requestId: z.string(), answers: Answers.optional() }), Ok),
  "agent.respondPermission": method(
    z.object({ id: z.string(), requestId: z.string(), decision: PermissionDecision, message: z.string().optional() }),
    Ok,
  ),
  // Resolves when the agent is idle (or waiting for permission or an answer) or the timeout passes.
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

// Wire protocol shared by the casm server, the CLI and (via JSON Schema codegen) the Swift apps.
// JSON-RPC 2.0 over one WebSocket. Requests are listed in `methods`; server
// notifications in `notifications`. A request with a `host` (a peer's name or
// server id) is forwarded to that peer server; notifications relayed from it
// carry the same `host`.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Domain

export const ProviderId = z.enum(["claude", "codex", "pi", "opencode"]);
export type ProviderId = z.infer<typeof ProviderId>;

// A hand-picked folder. `group` is only a visual grouping label for clients.
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  group: z.string().nullable(),
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
  // Give the agent casm's own MCP tools (list hosts and agents, create and
  // drive agents here or on peer servers). Children it creates get it as parent.
  casmTools: z.boolean().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

// The agent that created this one, possibly on another server. `serverId`
// matches `server.info` id, so clients can map it to one of their hosts;
// `host` is only a display hint.
export const AgentParent = z.object({ serverId: z.string(), agentId: z.string(), host: z.string().optional() });
export type AgentParent = z.infer<typeof AgentParent>;

// Another casm server this one can call on behalf of its agents. The peer's
// token is never sent to clients.
export const Peer = z.object({
  name: z.string(),
  url: z.string(),
  // The peer's `server.info` id, recorded when it was added.
  serverId: z.string().nullable(),
  // Only present when `peer.list` was asked to probe.
  reachable: z.boolean().optional(),
  error: z.string().optional(),
});
export type Peer = z.infer<typeof Peer>;

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
  // The model the agent's session runs, as the provider last reported it. Set
  // when config.model is unset too (the provider's own default, e.g. Codex's
  // config.toml), so clients show it instead of guessing from the catalog.
  // Null until a session reports one, and again after config.model changes.
  effectiveModel: z.string().nullable().optional(),
  parent: AgentParent.nullable(),
  tags: z.array(z.string()),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: AgentStatus,
  // A prompt waiting for a provider limit to reset; the server sends it then.
  deferred: z.object({ until: z.string(), reason: z.string() }).nullable().optional(),
  // Messages waiting to be sent (see agent.pending): how many, and when the
  // next one is due if they wait for a limit reset.
  pending: z.object({ count: z.number(), next: z.string().optional() }).optional(),
  // Provider-internal subagents (Item.subagent) running in the agent's live
  // session, background ones included: they can run while the agent is idle.
  subagents: z.object({ running: z.number() }).optional(),
});
export type Agent = z.infer<typeof Agent>;

// One normalized transcript entry. History and live events use the same shape;
// clients upsert by `id`.
export const ImageData = z.object({
  mediaType: z.string(),
  // Base64. History may omit it for very large images.
  data: z.string().optional(),
});
export type ImageData = z.infer<typeof ImageData>;

export const PlanEntry = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanEntry = z.infer<typeof PlanEntry>;

// Context and cost, as far as the agent reports them.
export const Usage = z.object({
  model: z.string().optional(),
  contextTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  // Totals for one subagent run (Item.subagent.usage).
  totalTokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

// A message waiting for its agent to become available: behind a running turn
// ("queued") or until a usage limit resets ("limit"). Sent in order; a waiting
// "limit" entry holds back the rest. Time-based sends are schedules.
// "failed": the prompt of a turn that failed before the agent produced
// anything (say its session could not be resumed), so it may never have reached
// the agent's own history. `note` has the error. It is kept, not resent, until
// agent.retryPending or agent.cancelPending.
export const PendingMessage = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  imageCount: z.number().optional(),
  reason: z.enum(["queued", "limit", "failed"]),
  notBefore: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.string(),
});
export type PendingMessage = z.infer<typeof PendingMessage>;

// A host-level job: on a cadence, message an existing agent or start a new
// agent from a preset. A message to a busy or limited agent becomes pending.
export const ScheduleCadence = z.discriminatedUnion("type", [
  // 5-field cron in the server's local time.
  z.object({ type: z.literal("cron"), expr: z.string() }),
  z.object({ type: z.literal("every"), minutes: z.number().int().positive() }),
  // One run at a time (ISO); the schedule disables itself afterwards.
  z.object({ type: z.literal("once"), at: z.string() }),
]);
export type ScheduleCadence = z.infer<typeof ScheduleCadence>;

export const ScheduleTarget = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    agentId: z.string(),
    // When the agent is busy or limited: queue the message (default) or skip this run.
    whenBusy: z.enum(["queue", "skip"]).optional(),
  }),
  z.object({
    type: z.literal("newAgent"),
    projectId: z.string(),
    provider: ProviderId,
    config: AgentConfig.optional(),
    // Name for the new agents; the run time is appended.
    name: z.string().optional(),
  }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTarget>;

export const ScheduleRun = z.object({
  at: z.string(),
  outcome: z.enum(["sent", "queued", "skipped", "created", "failed"]),
  agentId: z.string().optional(),
  error: z.string().optional(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  cadence: ScheduleCadence,
  target: ScheduleTarget,
  prompt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRun: ScheduleRun.nullable(),
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;

// A subagent the agent spawned itself (Claude Task/Agent tool, including
// background ones, Codex sub-agents, OpenCode child sessions). Upserted by id
// as it runs; its own transcript is read with agent.subagentHistory.
export const SubagentItem = z.object({
  kind: z.literal("subagent"),
  id: z.string(),
  title: z.string(),
  agentType: z.string().optional(),
  status: z.enum(["running", "done", "error"]),
  // Latest thing it did, e.g. the tool it is running.
  activity: z.string().optional(),
  summary: z.string().optional(),
  usage: Usage.optional(),
});
export type SubagentItem = z.infer<typeof SubagentItem>;

// A subagent as agent.subagents lists it: the provider's latest item plus where
// it comes from. `stale`: the provider last reported it running, but the
// session that ran it has ended, so no completion can arrive any more.
export const SubagentInfo = SubagentItem.omit({ kind: true }).extend({
  agentId: z.string(),
  // When this server first and last saw it (absent when read from the transcript only).
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  stale: z.boolean().optional(),
});
export type SubagentInfo = z.infer<typeof SubagentInfo>;

export const Item = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string(), images: z.array(ImageData).optional() }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string() }),
  z.object({ kind: z.literal("reasoning"), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    origin: z.enum(["user", "agent"]).optional(),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    status: z.enum(["running", "done", "error"]),
    output: z.string().optional(),
  }),
  SubagentItem,
  // Status lines: interrupts, retries, compaction, warnings. Upserted by id, so
  // a retry notice can update its countdown.
  z.object({ kind: z.literal("notice"), id: z.string(), text: z.string(), level: z.enum(["info", "warning", "error"]).optional() }),
  // The agent's todo list / plan. Each update replaces the entries.
  z.object({ kind: z.literal("plan"), id: z.string(), entries: z.array(PlanEntry) }),
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


// Subscription / account limits of an agent provider on this host (e.g. Claude's
// five-hour and weekly windows, Codex's primary and secondary windows).
export const LimitWindow = z.object({
  id: z.string(),
  label: z.string().optional(),
  usedPercent: z.number().optional(),
  resetsAt: z.string().optional(),
  windowMinutes: z.number().optional(),
  status: z.enum(["ok", "warning", "exhausted"]).optional(),
});
export type LimitWindow = z.infer<typeof LimitWindow>;

export const ProviderLimits = z.object({
  provider: ProviderId,
  plan: z.string().optional(),
  windows: z.array(LimitWindow),
  // When the provider last reported them.
  updatedAt: z.string(),
});
export type ProviderLimits = z.infer<typeof ProviderLimits>;

export const Command = z.object({
  // Typed after "/" in the composer.
  name: z.string(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  kind: z.enum(["command", "skill"]).optional(),
});
export type Command = z.infer<typeof Command>;

export const TurnOutcome = z.enum(["completed", "interrupted", "failed"]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

// One note in an agent's memory store. `id` is stable for update/delete
// (for file-backed stores, the path relative to `location`).
export const MemoryEntry = z.object({
  id: z.string(),
  title: z.string().optional(),
  text: z.string(),
  updatedAt: z.string().optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

// The memories one agent keeps that apply to a project folder. "project"
// stores are keyed by the folder (Claude Code); "global" ones apply to every
// folder (Codex). Memories are read-only in casm; only AGENTS.md is editable.
export const AgentMemories = z.object({
  provider: ProviderId,
  scope: z.enum(["project", "global"]),
  location: z.string(),
  entries: z.array(MemoryEntry),
});
export type AgentMemories = z.infer<typeof AgentMemories>;

// Live events for one agent. `delta` streams text into a transient draft that
// the client drops when the next assistant/reasoning `item` arrives.
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turnStarted"), turnId: z.string() }),
  z.object({ type: z.literal("item"), item: Item }),
  z.object({ type: z.literal("delta"), kind: z.enum(["assistant", "reasoning"]), text: z.string() }),
  // Appends to a running tool item's output; the final tool item replaces it.
  z.object({ type: z.literal("toolOutput"), itemId: z.string(), text: z.string() }),
  z.object({ type: z.literal("usage"), usage: Usage }),
  z.object({ type: z.literal("permission"), request: PermissionRequest }),
  z.object({ type: z.literal("permissionResolved"), requestId: z.string() }),
  z.object({ type: z.literal("question"), request: QuestionRequest }),
  z.object({ type: z.literal("questionResolved"), requestId: z.string() }),
  z.object({
    type: z.literal("turnEnded"),
    turnId: z.string(),
    outcome: TurnOutcome,
    error: z.string().optional(),
    // Set when the turn failed on a usage/rate limit; the prompt is deferred.
    limit: z.object({ message: z.string(), resetsAt: z.string().optional() }).optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentPromptInfo = z.object({
  enabled: z.boolean(),
  content: z.string(),
  custom: z.boolean(),
  default: z.string(),
  // Where the custom prompt lives on the host; null when the server keeps no state directory.
  path: z.string().nullable(),
  placeholders: z.array(z.string()),
  rendered: z.string().nullable(),
});
export type AgentPromptInfo = z.infer<typeof AgentPromptInfo>;

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
    z.object({ id: z.string(), name: z.string(), version: z.string(), protocol: z.number(), providers: z.array(ProviderId) }),
  ),

  // The host's agent prompt: put ahead of every agent's config.systemPrompt
  // when its session opens (start or resume), for all providers. `content` is
  // the template in effect: <state dir>/agent-prompt.md when there is one
  // (`custom`), else `default`. {{placeholders}} are filled per agent; `rendered`
  // is the result for `agentId`, or for an example agent. Null when disabled.
  "server.agentPrompt": method(z.object({ agentId: z.string().optional() }), AgentPromptInfo),
  // `content` saves agent-prompt.md (null deletes it, back to the default);
  // `enabled` is "agentPrompt" in the host's config.json. Applies to sessions
  // opened afterwards.
  "server.setAgentPrompt": method(
    z.object({ content: z.string().nullable().optional(), enabled: z.boolean().optional() }),
    AgentPromptInfo,
  ),

  // Peer servers (edited with `casm peer add|rm` on the server). `probe`
  // connects to each one to report `reachable`.
  "peer.list": method(z.object({ probe: z.boolean().optional() }), z.object({ peers: z.array(Peer) })),

  // Models and modes the agent offers on this host. Cached; `refresh` re-reads.
  "provider.catalog": method(z.object({ provider: ProviderId, refresh: z.boolean().optional() }), Catalog),
  "schedule.list": method(z.object({ agentId: z.string().optional() }), z.object({ schedules: z.array(Schedule) })),
  "schedule.create": method(
    z.object({ name: z.string().min(1).optional(), cadence: ScheduleCadence, target: ScheduleTarget, prompt: z.string().min(1), enabled: z.boolean().optional() }),
    Schedule,
  ),
  "schedule.update": method(
    z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      cadence: ScheduleCadence.optional(),
      target: ScheduleTarget.optional(),
      prompt: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    }),
    Schedule,
  ),
  "schedule.delete": method(ById, Ok),
  // Runs it now, without changing its cadence.
  "schedule.runNow": method(ById, ScheduleRun),

  // Everything waiting on this server: pending messages of every agent, and
  // agents blocked on a permission prompt or a question.
  "pending.list": method(
    Empty,
    z.object({
      messages: z.array(PendingMessage),
      blocked: z.array(z.object({ agentId: z.string(), permissions: z.number(), questions: z.number() })),
    }),
  ),
  // Latest known subscription limits per provider (all installed ones by default).
  // `refresh` asks providers that can be queried; others report what their
  // sessions last saw.
  "provider.limits": method(
    z.object({ provider: ProviderId.optional(), refresh: z.boolean().optional() }),
    z.object({ limits: z.array(ProviderLimits) }),
  ),

  // Files and directories under `cwd` (or the agent's cwd) matching `query`,
  // for @-mentions. Paths are relative; .gitignore is respected.
  "fs.search": method(
    z.object({ agentId: z.string().optional(), cwd: z.string().optional(), query: z.string(), limit: z.number().optional() }),
    z.object({ root: z.string(), entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]) })) }),
  ),

  "project.list": method(z.object({ includeArchived: z.boolean().optional() }), z.object({ projects: z.array(Project) })),
  "project.create": method(
    z.object({
      // Absolute path on the server; the name defaults to its last segment.
      path: z.string().min(1),
      name: z.string().min(1).optional(),
      group: z.string().nullish(),
      tags: z.array(z.string()).optional(),
    }),
    Project,
  ),
  "project.update": method(
    z.object({
      id: z.string(),
      // The name and folder are fixed at creation: agents key their memories
      // and sessions by the folder path.
      // null removes the project from its group.
      group: z.string().nullish(),
      tags: z.array(z.string()).optional(),
      sort: z.number().optional(),
      archived: z.boolean().optional(),
    }),
    Project,
  ),
  "project.delete": method(ById, Ok),

  // <project path>/AGENTS.md, which Codex, OpenCode, pi and Claude Code read.
  // `content` is null when the file doesn't exist.
  "project.agentsMd": method(ById, z.object({ path: z.string(), content: z.string().nullable(), sha256: z.string().nullable() })),
  "project.setAgentsMd": method(z.object({ id: z.string(), content: z.string(), expectedSha256: z.string().nullable().optional() }), z.object({ path: z.string(), content: z.string() })),
  // Each installed agent's memories that apply to the project folder. Agents
  // with no memory store (or nothing stored) are left out.
  "project.memories": method(ById, z.object({ agents: z.array(AgentMemories) })),

  "agent.list": method(
    z.object({ projectId: z.string().optional(), includeArchived: z.boolean().optional() }),
    z.object({ agents: z.array(Agent) }),
  ),
  "agent.get": method(ById, Agent),
  // The working directory is always the project's folder.
  "agent.create": method(
    z.object({
      projectId: z.string(),
      provider: ProviderId,
      name: z.string().optional(),
      config: AgentConfig.optional(),
      parent: AgentParent.optional(),
      tags: z.array(z.string()).optional(),
      prompt: z.string().optional(),
      images: z.array(ImageData).optional(),
    }),
    Agent,
  ),
  // `config` fields merge into the current config ("" clears one) and apply
  // when the session is next opened: right away if idle, else after the turn.
  "agent.update": method(
    z.object({
      id: z.string(),
      // Agents stay in the project they were created in.
      name: z.string().min(1).optional(),
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
    z.object({
      id: z.string(),
      text: z.string(),
      images: z.array(ImageData).optional(),
      whenBusy: z.enum(["queue", "steer"]).optional(),
      // While the provider is known to be over its limit: "queue" (default)
      // defers the prompt until the reset; "fail" rejects with code 1004.
      whenLimited: z.enum(["queue", "fail"]).optional(),
    }),
    z.object({ queued: z.boolean(), deferredUntil: z.string().optional(), pendingId: z.string().optional() }),
  ),
  // Latest known context/cost: from the live session, else read from the
  // provider's store. Null when the agent has not run yet.
  "agent.usage": method(ById, z.object({ usage: Usage.nullable() })),
  // Transcript of one subagent (Item.subagent id) from the provider's store.
  "agent.subagentHistory": method(
    z.object({ id: z.string(), subagentId: z.string(), limit: z.number().optional() }),
    z.object({ items: z.array(Item) }),
  ),
  // Subagents of one agent (`id`), or of every agent. Running ones first, then
  // the most recently seen. The live ones come from the running sessions; for
  // one agent, those its transcript records are added too. `limit` caps the
  // finished ones per agent (default 10).
  "agent.subagents": method(
    z.object({ id: z.string().optional(), limit: z.number().int().nonnegative().optional() }),
    z.object({ subagents: z.array(SubagentInfo) }),
  ),
  // Slash commands and skills the agent accepts. Send them as text ("/name args").
  "agent.commands": method(ById.extend({ refresh: z.boolean().optional() }), z.object({ commands: z.array(Command) })),
  // Runs a shell command in the agent's cwd as the user ("!cmd"). It shows as a
  // tool item with streamed output, and lands in the agent's own history and
  // context the way the agent does it natively. Rejected while a turn runs.
  "agent.shell": method(z.object({ id: z.string(), command: z.string().min(1) }), Ok),
  // Messages waiting to be sent to this agent, in order.
  "agent.pending": method(ById, z.object({ messages: z.array(PendingMessage) })),
  // Sends a "failed" pending message again (as agent.send would) and removes it.
  "agent.retryPending": method(
    z.object({ id: z.string(), messageId: z.string() }),
    z.object({ queued: z.boolean(), deferredUntil: z.string().optional(), pendingId: z.string().optional() }),
  ),
  // Cancels one pending message, or all of them when `messageId` is omitted.
  "agent.cancelPending": method(z.object({ id: z.string(), messageId: z.string().optional() }), z.object({ cancelled: z.number() })),
  // Interrupts the running turn and drops its pending messages.
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
  // `lastTurn`: how the agent's last turn since the server started ended; `kept`: the
  // pending messages it kept as failed (prompts nothing came back for), oldest first.
  "agent.wait": method(
    z.object({ id: z.string(), timeoutMs: z.number().optional() }),
    z.object({
      status: AgentStatus,
      timedOut: z.boolean(),
      lastReply: z.string().nullable(),
      lastTurn: z
        .object({ outcome: z.enum(["completed", "interrupted", "failed"]), error: z.string().optional(), kept: z.array(z.string()).optional() })
        .nullable()
        .optional(),
    }),
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
  "provider.limits": z.object({ limits: ProviderLimits }),
  "schedule.changed": z.object({ schedule: Schedule }),
  "schedule.removed": z.object({ scheduleId: z.string() }),
  "project.removed": z.object({ projectId: z.string() }),
  // The connection to a peer dropped; subscriptions made through it are gone.
  "peer.disconnected": z.object({ host: z.string() }),
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
  Limited: 1004,
  // A forwarded request's peer could not be reached or did not answer.
  Unreachable: 1005,
} as const;

export type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown; host?: string };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params: unknown; host?: string };

import type {
  AgentConfig,
  Answers,
  Catalog,
  Command,
  ImageData,
  Item,
  MemoryEntry,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  QuestionRequest,
  TurnOutcome,
  Usage,
  ProviderLimits,
} from "@casm/protocol";

// What a provider reports while a session is open.
export type ProviderEvent =
  | { type: "userMessageId"; itemId: string; nativeId: string }
  | { type: "sessionId"; id: string }
  // The model the session runs (resolved by the provider when config.model is unset).
  | { type: "model"; model: string }
  | { type: "item"; item: Item }
  | { type: "delta"; kind: "assistant" | "reasoning"; text: string }
  // Output of a running tool, appended to the tool item with that id.
  | { type: "toolOutput"; itemId: string; text: string }
  // Partial updates merge into the agent's last known usage.
  | { type: "usage"; usage: Usage }
  // Account/subscription limits as the agent last reported them (provider-wide).
  | { type: "limits"; limits: Omit<ProviderLimits, "provider" | "updatedAt"> }
  // Echo the manager token, captured when dispatching work. A late completion
  // must never finish a subsequent turn on the same native session.
  | { type: "turnEnded"; outcome: TurnOutcome; error?: string; turnId?: string; recycleSession?: boolean }
  // The process is gone; the manager drops the session and reopens on next send.
  | { type: "closed"; error?: string };

export type PermissionAnswer = { decision: PermissionDecision; message?: string };

export type OpenOptions = {
  cwd: string;
  config: AgentConfig;
  resumeId: string | null;
  emit: (e: ProviderEvent) => void;
  // Resolves when a client answers. Rejects (via signal) if the turn is aborted.
  askPermission: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
  // Resolves with the answers, or null when the user dismisses the question.
  askQuestion: (req: QuestionRequest, signal: AbortSignal) => Promise<Answers | null>;
};

// One live provider process bound to one native session.
export interface ProviderSession {
  // Starts a turn, or folds the text into the running turn (steer).
  send(text: string, itemId: string, images?: ImageData[], turnId?: string): void;
  // Runs a user shell command as its own turn: emit a tool item with id
  // `itemId` (name "shell", input {command}), toolOutput while it runs, the
  // finished item, then turnEnded. Record it in the agent's history/context.
  shell(command: string, itemId: string, turnId?: string): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  open(opts: OpenOptions): ProviderSession;
  // Reads the transcript from the provider's own store.
  history(sessionId: string, cwd: string): Promise<Item[]>;
  // Exact native identity aliases when live events and disk entries use different IDs.
  historyAliases?(sessionId: string, cwd: string): Promise<Record<string, string>>;
  // Models and modes available on this host. The manager caches the result.
  catalog(): Promise<Catalog>;
  // Last known context/cost from the provider's store (for agents not running now).
  usage(sessionId: string, cwd: string): Promise<Usage | null>;
  // Slash commands and skills available in `cwd`.
  commands(cwd: string): Promise<Command[]>;
  // Queries account limits directly when the agent can (e.g. Codex). Others
  // leave it out and report limits as "limits" events from their sessions.
  limits?(): Promise<Omit<ProviderLimits, "provider" | "updatedAt"> | null>;
  // Items of one subagent's own transcript (Item.subagent id).
  subagentHistory?(sessionId: string, cwd: string, subagentId: string): Promise<Item[]>;
  // Memories that apply to `cwd`; null when the agent has none. Agents without
  // a memory store leave these out.
  memories?(cwd: string): Promise<ProviderMemories | null>;
}

export type ProviderMemories = {
  scope: "project" | "global";
  location: string;
  entries: MemoryEntry[];
};

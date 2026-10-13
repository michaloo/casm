import type { AgentConfig, Item, PermissionDecision, PermissionRequest, ProviderId, TurnOutcome } from "@casm/protocol";

// What a provider reports while a session is open.
export type ProviderEvent =
  | { type: "sessionId"; id: string }
  | { type: "item"; item: Item }
  | { type: "delta"; kind: "assistant" | "reasoning"; text: string }
  | { type: "turnEnded"; outcome: TurnOutcome; error?: string }
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
};

// One live provider process bound to one native session.
export interface ProviderSession {
  // Starts a turn, or folds the text into the running turn (steer).
  send(text: string, itemId: string): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  open(opts: OpenOptions): ProviderSession;
  // Reads the transcript from the provider's own store.
  history(sessionId: string, cwd: string): Promise<Item[]>;
}

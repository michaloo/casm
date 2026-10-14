// The composer's side of the queue: messages shown before the server confirms
// them, matched to the server's rows and items by the id the client chose.
import type { AgentStatus, PendingMessage } from "@casm/protocol";

// A v4 UUID. crypto.randomUUID needs a secure context, which a plain-http
// server on a LAN or tailnet address is not; getRandomValues works everywhere.
export function newMessageId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type Outbox = {
  pending: PendingMessage[];
  // Sent but not yet confirmed, shown as queued rows.
  outbox?: PendingMessage[];
  // Rows the user sent now or cancelled, hidden until the server confirms.
  hidden?: Set<string>;
};

// The queue as the user should see it: the server's rows minus the ones being
// taken out, then local ones the server has not listed yet.
export function visiblePending(c: Outbox): PendingMessage[] {
  const hidden = c.hidden ?? new Set();
  const listed = new Set(c.pending.map((p) => p.id));
  return [...c.pending.filter((p) => !hidden.has(p.id)), ...(c.outbox ?? []).filter((p) => !listed.has(p.id) && !hidden.has(p.id))];
}

// What a plain send (Enter) does: start a turn, or wait in the queue behind a
// running turn or behind messages that are already waiting.
export function sendMode(status: AgentStatus | undefined, waiting: number): "send" | "queue" {
  return (status && status !== "idle") || waiting > 0 ? "queue" : "send";
}

// The label and the action offered for one pending row.
export function pendingLabel(p: PendingMessage, now = Date.now()): { status: string; action: "send-now" | "retry" } {
  if (p.reason === "failed") return { status: `Not delivered${p.note ? ` · ${p.note}` : ""}`, action: "retry" };
  if (p.reason === "limit") {
    const at = p.notBefore ? Date.parse(p.notBefore) : NaN;
    const when = Number.isFinite(at) && at > now ? ` until ${new Date(at).toLocaleString()}` : "";
    return { status: `Waiting for the usage limit${when}${p.note ? ` · ${p.note}` : ""}`, action: "retry" };
  }
  return { status: "Queued", action: "send-now" };
}

// The first row holds the queue when it failed or waits for a limit.
export function queueHeld(rows: PendingMessage[]): boolean {
  return rows[0]?.reason === "failed" || rows[0]?.reason === "limit";
}

// Why a turn failed, and whether trying the same prompt again can help.
// Transient failures come from casm or the environment (the server stopped,
// the agent process died, a connection dropped, the provider was overloaded)
// and are retried automatically with backoff. Permanent ones (auth, an unknown
// model, a missing folder, an invalid config) hold the queue for the user.
// Usage limits are not failures here: they wait for the reset (limits.ts).

// Where the failure was seen: the provider's own turn result, its process
// ending mid-turn, the provider throwing while taking the prompt, or the
// server stopping under the turn.
export type FailureSource = "provider" | "process" | "dispatch" | "stopped";
export type FailureKind = "transient" | "permanent";

// Backoff before each automatic retry; its length is the number of retries.
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

// Retrying the same prompt won't fix these, whatever reported them.
const PERMANENT =
  /\bauth|unauthori[sz]ed|forbidden|\b40[13]\b|api[ _-]?key|not logged in|log ?in required|sign[ -]?in|credential|unknown model|model\b.*\b(?:not (?:found|exist|available|supported)|does not exist|invalid)|invalid|does not exist|no such file|no conversation found|not found|permission denied|not allowed/i;

// What a provider says when the trouble is on its side or on the way to it.
const TRANSIENT =
  /overloaded|\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|timed? ?out|\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|NETUNREACH|HOSTUNREACH)\b|socket hang up|network|connection (?:error|reset|closed|refused|lost)|fetch failed|stream (?:closed|ended|error)|process exited|exited unexpectedly|crashed|terminated|killed/i;

export function classifyFailure(source: FailureSource, error = ""): FailureKind {
  if (source === "stopped") return "transient";
  if (PERMANENT.test(error)) return "permanent";
  // The process dying or refusing the prompt is the environment's doing unless
  // it said otherwise; a provider's own error must be one we recognise.
  if (source !== "provider") return "transient";
  return TRANSIENT.test(error) ? "transient" : "permanent";
}

// When to retry after `attempts` automatic retries so far, or null to give up.
export function nextRetryAt(attempts: number, now = Date.now()): string | null {
  return attempts < MAX_RETRIES ? new Date(now + RETRY_DELAYS_MS[attempts]).toISOString() : null;
}

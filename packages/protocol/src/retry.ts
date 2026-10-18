// "Retrying in 1m 40s (attempt 2 of 3)" for a failed pending message that is
// retried automatically (PendingMessage.retry), shared by the CLI and web app.
import type { PendingMessage } from "./index.ts";

export function retryLabel(m: Pick<PendingMessage, "retry" | "notBefore">, now = Date.now()): string | null {
  if (!m.retry || !m.notBefore) return null;
  const left = Math.ceil((Date.parse(m.notBefore) - now) / 1000);
  const attempt = `(attempt ${m.retry.attempt} of ${m.retry.of})`;
  return left > 0 ? `Retrying in ${duration(left)} ${attempt}` : `Retrying now ${attempt}`;
}

function duration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

// Recognises usage/rate-limit failures in agent error text and works out when
// to try again. Providers that report limits structurally do so through
// "limits" events; this covers the rest and the plain-text messages.

const LIMIT = /usage limit|rate[ -]?limit|quota|too many requests|\b429\b|limit (?:reached|exceeded)|out of (?:credits|extra usage)|credits_required/i;

export type LimitHit = { message: string; resetsAt?: string };

export function limitFromText(text: string | undefined, now = new Date()): LimitHit | null {
  if (!text || !LIMIT.test(text)) return null;
  const resetsAt = resetTime(text, now);
  return { message: text.trim().slice(0, 500), resetsAt: resetsAt?.toISOString() };
}

// Accepts "try again at 6:31 PM", "resets 18:31", an ISO timestamp, "in 2 hours",
// "in 15 minutes" or a trailing "|<epoch seconds>" (Claude's old format).
export function resetTime(text: string, now = new Date()): Date | undefined {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso && !Number.isNaN(Date.parse(iso[0]))) return new Date(iso[0]);
  const rel = text.match(/in (\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|day)s?\b/i);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2][0].toLowerCase() as "s" | "m" | "h" | "d"];
    return new Date(now.getTime() + Number(rel[1]) * unit);
  }
  const clock = text.match(/(?:at|after|until|resets?)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d-])/i);
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1]) % 24;
    const m = Number(clock[2] ?? 0);
    const ampm = clock[3]?.toLowerCase().replace(/\./g, "");
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t;
  }
  return undefined;
}

// When to retry: a minute after the reset, else back off 15 min, doubling, up to 3 h.
export function retryAt(hit: LimitHit, attempts: number, now = new Date()): Date {
  if (hit.resetsAt) {
    const t = Date.parse(hit.resetsAt) + 60_000;
    if (t > now.getTime()) return new Date(t);
  }
  return new Date(now.getTime() + Math.min(15 * 60_000 * 2 ** attempts, 3 * 3600_000));
}

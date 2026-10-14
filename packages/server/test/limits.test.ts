import { test } from "node:test";
import assert from "node:assert/strict";
import { limitFromText, mergeWindows, resetTime, retryAt } from "../src/limits.ts";

const now = new Date("2026-10-13T16:40:00");

test("recognises limit errors and ignores others", () => {
  assert.ok(limitFromText("You've hit your usage limit. Upgrade to Pro ... or try again at 6:31 PM."));
  assert.ok(limitFromText("Rate limit reached (five-hour limit)"));
  assert.ok(limitFromText("API Error: 429 Too Many Requests"));
  assert.equal(limitFromText("TypeError: cannot read properties of undefined"), null);
  assert.equal(limitFromText(undefined), null);
});

test("parses reset times", () => {
  assert.equal(resetTime("try again at 6:31 PM", now)?.getHours(), 18);
  assert.equal(resetTime("try again at 6:31 PM", now)?.getMinutes(), 31);
  // Already past today: tomorrow.
  assert.equal(resetTime("resets at 9am", now)?.getDate(), 14);
  assert.equal(resetTime("limit reached, resets 2026-10-13T20:00:00Z", now)?.toISOString(), "2026-10-13T20:00:00.000Z");
  assert.equal(resetTime("try again in 2 hours", now)?.getTime(), now.getTime() + 2 * 3600_000);
  assert.equal(resetTime("Claude AI usage limit reached|1760380260", now)?.getTime(), 1760380260_000);
  assert.equal(resetTime("usage limit exceeded", now), undefined);
});

test("retry a minute after the reset, else back off", () => {
  assert.equal(retryAt({ message: "x", resetsAt: "2026-10-13T18:00:00.000Z" }, 0, new Date("2026-10-13T17:00:00Z")).toISOString(), "2026-10-13T18:01:00.000Z");
  const base = new Date("2026-10-13T17:00:00Z");
  assert.equal(retryAt({ message: "x" }, 0, base).getTime() - base.getTime(), 15 * 60_000);
  assert.equal(retryAt({ message: "x" }, 2, base).getTime() - base.getTime(), 60 * 60_000);
  assert.equal(retryAt({ message: "x" }, 9, base).getTime() - base.getTime(), 3 * 3600_000);
});

test("merged windows keep known usage when a report leaves it out", () => {
  const prev = [{ id: "five_hour", usedPercent: 43, resetsAt: "2026-10-14T02:30:00Z", status: "ok" as const }];
  // A live Claude event: no utilization, a fresher reset time.
  const merged = mergeWindows(prev, [{ id: "five_hour", label: "5-hour", usedPercent: undefined, resetsAt: "2026-10-14T02:30:01Z", status: "ok" }]);
  assert.deepEqual(merged, [{ id: "five_hour", label: "5-hour", usedPercent: 43, resetsAt: "2026-10-14T02:30:01Z", status: "ok" }]);
  assert.deepEqual(mergeWindows(merged, [{ id: "seven_day", usedPercent: 17 }]).map((w) => w.id), ["five_hour", "seven_day"]);
});

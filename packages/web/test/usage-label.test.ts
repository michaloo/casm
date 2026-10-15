import { test } from "node:test";
import assert from "node:assert/strict";
import { usageLabel, resetLabel, elapsedPercent } from "../src/usage-label.ts";

test("usage shows provider status alongside percentages including zero", () => {
  assert.equal(usageLabel({ id: "week", usedPercent: 99.6, status: "exhausted" }), "100% used · exhausted");
  assert.equal(usageLabel({ id: "hour", usedPercent: 0, status: "ok" }), "0% used · ok");
});
test("reset time is relative, readable and safe for expired/invalid dates", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(resetLabel("2026-10-14T12:14:00Z", now), "in 14m");
  assert.equal(resetLabel("2026-10-14T14:30:00Z", now), "in 2h 30m");
  assert.equal(resetLabel("2026-10-16T15:00:00Z", now), "in 2d 3h");
  assert.equal(resetLabel("2026-10-14T11:00:00Z", now), "now");
  assert.equal(resetLabel("invalid", now), "at an unknown time");
});
test("missing percentage preserves status and unavailable values are explicit", () => {
  assert.equal(usageLabel({ id: "week", status: "warning" }), "warning");
  assert.equal(usageLabel({ id: "week" }), "Usage unknown");
});

test("elapsed share of a window comes from its length and reset", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(elapsedPercent({ id: "five_hour", windowMinutes: 300, resetsAt: "2026-10-15T14:00:00Z" }, now), 60);
  assert.equal(elapsedPercent({ id: "w", windowMinutes: 300, resetsAt: "2026-10-15T11:00:00Z" }, now), 100);
  assert.equal(elapsedPercent({ id: "w", windowMinutes: 300, resetsAt: "2026-10-15T20:00:00Z" }, now), 0);
  assert.equal(elapsedPercent({ id: "w", resetsAt: "2026-10-15T14:00:00Z" }, now), undefined);
  assert.equal(elapsedPercent({ id: "w", windowMinutes: 300 }, now), undefined);
});

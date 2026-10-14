import { test } from "node:test";
import assert from "node:assert/strict";
import { cadenceLabel, targetLabel, parseCadence, agoLabel } from "../src/schedule-label.ts";

test("cadence labels use the largest whole unit", () => {
  assert.equal(cadenceLabel({ type: "every", minutes: 1 }), "Every minute");
  assert.equal(cadenceLabel({ type: "every", minutes: 30 }), "Every 30 minutes");
  assert.equal(cadenceLabel({ type: "every", minutes: 120 }), "Every 2 hours");
  assert.equal(cadenceLabel({ type: "every", minutes: 1440 }), "Every day");
  assert.equal(cadenceLabel({ type: "cron", expr: "0 9 * * 1-5" }), "Cron 0 9 * * 1-5");
});
test("targets name agents and projects, tolerating removed ones", () => {
  const names = { agents: new Map([["a", "Reviewer"]]), projects: new Map([["p", "casm"]]) };
  assert.equal(targetLabel({ type: "agent", agentId: "a" }, names), "Message Reviewer");
  assert.equal(targetLabel({ type: "agent", agentId: "x", whenBusy: "skip" }, names), "Message a removed agent · skip when busy");
  assert.equal(targetLabel({ type: "newAgent", projectId: "p", provider: "claude" }, names), "New agent in casm");
});
test("cadence form input is validated", () => {
  assert.deepEqual(parseCadence("every", " 15 "), { type: "every", minutes: 15 });
  assert.equal(typeof parseCadence("every", "1.5"), "string");
  assert.deepEqual(parseCadence("cron", "0 9 * * 1-5"), { type: "cron", expr: "0 9 * * 1-5" });
  assert.equal(typeof parseCadence("cron", "0 9 *"), "string");
  assert.equal((parseCadence("once", "2026-10-14T12:00:00Z") as { at: string }).at, "2026-10-14T12:00:00.000Z");
  assert.equal(typeof parseCadence("once", ""), "string");
});
test("past run times are relative", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(agoLabel("2026-10-14T11:59:40Z", now), "just now");
  assert.equal(agoLabel("2026-10-14T11:15:00Z", now), "45m ago");
  assert.equal(agoLabel("2026-10-14T07:00:00Z", now), "5h ago");
  assert.equal(agoLabel("2026-10-11T12:00:00Z", now), "3d ago");
});

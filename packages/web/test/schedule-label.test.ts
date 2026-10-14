import { test } from "node:test";
import assert from "node:assert/strict";
import { cadenceLabel, targetLabel, parseCadence, agoLabel, describeCron, cronPreview, dateLabel, isFinished } from "../src/schedule-label.ts";

test("cadence labels use the largest whole unit", () => {
  assert.equal(cadenceLabel({ type: "every", minutes: 1 }), "Every minute");
  assert.equal(cadenceLabel({ type: "every", minutes: 30 }), "Every 30 min");
  assert.equal(cadenceLabel({ type: "every", minutes: 120 }), "Every 2 hours");
  assert.equal(cadenceLabel({ type: "every", minutes: 1440 }), "Every day");
  assert.equal(cadenceLabel({ type: "cron", expr: "0 9 * * 1-5" }), "Weekdays at 09:00");
  assert.equal(cadenceLabel({ type: "cron", expr: "0 9 1-7 * 1" }), "Cron 0 9 1-7 * 1");
});
test("common crons read as words", () => {
  assert.equal(describeCron("30 17 * * *"), "Daily at 17:30");
  assert.equal(describeCron("0 9 * * 0,6"), "Weekends at 09:00");
  assert.equal(describeCron("0 9 * * 1"), "Mondays at 09:00");
  assert.equal(describeCron("0 9 * * 1,3,5"), "Mon, Wed, Fri at 09:00");
  assert.equal(describeCron("15 * * * *"), "Hourly at :15");
  assert.equal(describeCron("*/20 * * * *"), "Every 20 min");
  assert.equal(describeCron("0 */4 * * *"), "Every 4 hours");
  assert.equal(describeCron("0 8 1 * *"), "Monthly on day 1 at 08:00");
  assert.equal(describeCron("0 8 * 1 *"), undefined);
});
test("cron previews list the next runs or explain the error", () => {
  const runs = cronPreview("0 9 * * 1-5", 2, new Date(2026, 9, 16, 12, 0)) as Date[];
  assert.deepEqual(runs.map((d) => [d.getDate(), d.getHours()]), [[19, 9], [20, 9]]);
  assert.match(cronPreview("0 25 * * *") as string, /^Invalid cron field/);
});
test("dates are relative to today", () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime();
  assert.equal(dateLabel(new Date(2026, 9, 14, 18, 5).toISOString(), now), "today 18:05");
  assert.equal(dateLabel(new Date(2026, 9, 15, 9, 0).toISOString(), now), "tomorrow 09:00");
  assert.equal(dateLabel(new Date(2026, 9, 20, 9, 0).toISOString(), now), "Tue 20 Oct 09:00");
  assert.equal(dateLabel(new Date(2027, 0, 2, 9, 0).toISOString(), now), "Sat 2 Jan 2027 09:00");
});
test("one-offs that ran are finished", () => {
  const base = { id: "s", name: "n", prompt: "p", nextRunAt: null, createdAt: "", target: { type: "agent" as const, agentId: "a" } };
  assert.equal(isFinished({ ...base, enabled: false, cadence: { type: "once", at: "2026-10-14T00:00:00Z" }, lastRun: { at: "2026-10-14T00:00:00Z", outcome: "sent" } }), true);
  assert.equal(isFinished({ ...base, enabled: false, cadence: { type: "once", at: "2026-10-14T00:00:00Z" }, lastRun: null }), false);
  assert.equal(isFinished({ ...base, enabled: false, cadence: { type: "every", minutes: 5 }, lastRun: { at: "2026-10-14T00:00:00Z", outcome: "sent" } }), false);
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
  assert.deepEqual(parseCadence("cron", " 0  9 * * 1-5 "), { type: "cron", expr: "0 9 * * 1-5" });
  assert.equal(typeof parseCadence("cron", "0 9 * * 8"), "string");
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

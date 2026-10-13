import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCron, parseCron } from "../src/cron.ts";

const at = (s: string) => new Date(s);
const next = (expr: string, after: string) => nextCron(parseCron(expr), at(after)).toString();

test("cron: common expressions", () => {
  assert.equal(next("*/15 * * * *", "2026-10-13T10:07:30"), at("2026-10-13T10:15:00").toString());
  assert.equal(next("0 9 * * 1-5", "2026-10-16T09:00:00"), at("2026-10-19T09:00:00").toString()); // Fri 9:00 -> Mon
  assert.equal(next("30 18 * * *", "2026-10-13T18:30:00"), at("2026-10-14T18:30:00").toString());
  assert.equal(next("0 0 1 * *", "2026-10-13T00:00:00"), at("2026-11-01T00:00:00").toString());
  assert.equal(next("0 12 * * 0", "2026-10-13T00:00:00"), at("2026-10-18T12:00:00").toString()); // Sunday
  assert.equal(next("0 12 * * 7", "2026-10-13T00:00:00"), at("2026-10-18T12:00:00").toString());
  assert.equal(next("0 8 1,15 * *", "2026-10-02T00:00:00"), at("2026-10-15T08:00:00").toString());
});

test("cron: rejects bad expressions", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /invalid cron field/);
  assert.throws(() => parseCron("*/0 * * * *"), /invalid cron field/);
  assert.throws(() => nextCron(parseCron("0 0 31 2 *"), new Date()), /never matches/);
});

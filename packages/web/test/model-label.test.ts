import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabels } from "../src/model-label.ts";

const models = [{ id: "sonnet", name: "Sonnet", isDefault: true }, { id: "opus", name: "Opus" }];
test("default selection shows reported session model before catalog default", () => {
  const labels = modelLabels("", "opus", models);
  assert.equal(labels.defaultLabel, "Default · Opus");
  assert.equal(labels.sessionLabel, "Opus");
});
test("unresolved models clearly mark catalog estimate or missing identity", () => {
  assert.equal(modelLabels("", null, models).defaultLabel, "Default · Sonnet (catalog)");
  assert.equal(modelLabels("", null, models).actual, undefined);
  assert.equal(modelLabels("", null, []).defaultLabel, "Default · unresolved");
});
test("local selection never substitutes for the reported session model", () => {
  const labels = modelLabels("sonnet", "opus", models);
  assert.equal(labels.selectedLabel, "Sonnet");
  assert.equal(labels.sessionLabel, "Opus");
  assert.equal(labels.showSession, true);
});
test("unknown session ids remain visible and context variants retain their suffix", () => {
  assert.equal(modelLabels("", "custom", models).sessionLabel, "custom");
  assert.equal(modelLabels("", "sonnet[1m]", models).sessionLabel, "Sonnet · 1M");
});

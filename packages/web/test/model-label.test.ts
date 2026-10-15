import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabels, modelsDiffer, sessionModel } from "../src/model-label.ts";

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

const claude = [
  { id: "default", name: "Default (recommended)", isDefault: true },
  { id: "opus", name: "Opus 5.5" },
  { id: "sonnet", name: "Sonnet 4.6" },
  { id: "haiku", name: "Haiku 4.5" },
];
test("Claude full and dated IDs resolve through versioned catalog alias names", () => {
  for (const [id, label] of [
    ["opus", "Opus 5.5"], ["sonnet", "Sonnet 4.6"], ["default", "Default (recommended)"],
    ["claude-opus-5-5", "Opus 5.5"], ["claude-opus-5-5[1m]", "Opus 5.5 · 1M"],
    ["claude-sonnet-4-6[1M]", "Sonnet 4.6 · 1M"], ["sonnet[1m]", "Sonnet 4.6 · 1M"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"], ["claude-haiku-4-5-20251001[1m]", "Haiku 4.5 · 1M"],
  ]) {
    const labels = modelLabels(id, id, claude);
    assert.equal(labels.actual, label, id);
    assert.equal(labels.selectedLabel, label, id);
    assert.equal(labels.defaultLabel, `Default · ${label}`, id);
  }
});
test("aliases resolve full catalog IDs without assuming a different model version", () => {
  assert.equal(modelLabels("", "opus", [{ id: "claude-opus-5-5", name: "Opus 5.5" }]).actual, "Opus 5.5");
  assert.equal(modelLabels("", "default", [{ id: "gpt-6-astra", name: "GPT-6-Astra", isDefault: true }]).actual, "GPT-6-Astra");
  assert.equal(modelLabels("", "claude-3-5-sonnet-20241022", [{ id: "sonnet", name: "Claude Sonnet 3.5" }]).actual, "Claude Sonnet 3.5");
  assert.equal(modelLabels("", "claude-opus-4-1", claude).actual, "claude-opus-4-1");
  assert.equal(modelLabels("", "opus", [{ id: "claude-opus-4-1", name: "Opus 4.1" }, { id: "claude-opus-5-5", name: "Opus 5.5" }]).actual, "opus");
});
test("all providers use catalog names, qualified IDs and unambiguous snapshot matches", () => {
  for (const [id, catalog, label] of [
    ["gpt-6-astra", [{ id: "gpt-6-astra", name: "GPT-6-Astra" }], "GPT-6-Astra"],
    ["gpt-4.1-2025-04-14", [{ id: "gpt-4.1", name: "GPT-4.1" }], "GPT-4.1"],
    ["anthropic/claude-opus-5-5[1m]", [{ id: "anthropic/claude-opus-5-5", name: "Opus 5.5" }], "Opus 5.5 · 1M"],
    ["claude-haiku-4-5", [{ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }], "Haiku 4.5"],
    ["anthropic/claude-haiku-4-5-20251001", [{ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5" }], "Haiku 4.5"],
    ["claude-sonnet-4-6", [{ id: "anthropic/claude-sonnet-4-6", name: "Sonnet 4.6 (anthropic)" }], "Sonnet 4.6 (anthropic)"],
    ["ollama/my-model", [{ id: "ollama/my-model", name: "My local model" }], "My local model"],
  ] as const) assert.equal(modelLabels("", id, [...catalog]).actual, label, id);
});
test("explicit context variants are named once, with exact catalog variants taking priority", () => {
  const variants = [{ id: "opus", name: "Opus 5.5" }, { id: "opus[1m]", name: "Opus 5.5 (1M context)" }];
  assert.equal(modelLabels("", "opus[1m]", variants).actual, "Opus 5.5 · 1M");
  assert.equal(modelLabels("", "claude-opus-5-5[1m]", variants).actual, "Opus 5.5 · 1M");
  assert.equal(modelLabels("", "claude-opus-5-5", variants).actual, "Opus 5.5");
  assert.equal(modelLabels("", "claude-opus-5-5[1m]", [{ id: "claude-opus-5-5[1m]", name: "Custom label · 1M" }]).actual, "Custom label · 1M");
});
test("unknown, nameless and ambiguous models keep the exact raw identity", () => {
  for (const id of ["custom[1m]", "claude-future-10-20271001", "claude-opus-5-5[1m]"])
    assert.equal(modelLabels("", id, []).actual, id);
  assert.equal(modelLabels("", "custom[1m]", [{ id: "custom[1m]" }]).actual, "custom[1m]");
  const providers = [{ id: "one/model", name: "First model" }, { id: "two/model", name: "Second model" }];
  assert.equal(modelLabels("", "model", providers).actual, "model");
  assert.equal(modelLabels("", "three/model", providers).actual, "three/model");
  assert.equal(modelLabels("", "one/model", providers).actual, "First model");
});

// The stable server's Claude catalog: no 1M rows, as Opus 5.5 is natively 1M.
const live = [
  { id: "default", name: "Default (recommended)", isDefault: true },
  { id: "opus", name: "Opus 5.5" }, { id: "fable", name: "Fable 5.1" }, { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 4.5" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-opus-4-6", name: "Opus 4.6" },
];
test("an alias and the id it resolves to are the same model, with or without [1m]", () => {
  for (const [a, b] of [
    ["opus", "claude-opus-5-5"], ["opus", "claude-opus-5-5[1m]"], ["opus[1m]", "claude-opus-5-5"],
    ["opus[1m]", "claude-opus-5-5[1m]"], ["claude-opus-5-5", "claude-opus-5-5[1m]"],
    ["haiku", "claude-haiku-4-5-20251001"], ["claude-opus-4-6[1m]", "claude-opus-4-6"],
  ]) {
    assert.equal(modelsDiffer(a, b, live), false, `${a} vs ${b}`);
    assert.equal(modelsDiffer(b, a, live), false, `${b} vs ${a}`);
  }
});
test("different models differ; unknown or default identities never do", () => {
  for (const [a, b] of [["opus", "claude-sonnet-5-5"], ["opus", "claude-opus-5"], ["opus[1m]", "claude-opus-4-6[1m]"], ["sonnet", "claude-opus-5-5[1m]"], ["custom", "other"]])
    assert.equal(modelsDiffer(a, b, live), true, `${a} vs ${b}`);
  for (const [a, b] of [["default", "claude-opus-5-5"], ["", "claude-opus-5-5"], ["opus", null], ["opus", undefined], ["custom", "custom[1m]"]])
    assert.equal(modelsDiffer(a, b, live), false, `${a} vs ${b}`);
});
test("the session hint shows only for a real difference (agent with model opus, session claude-opus-5-5)", () => {
  assert.equal(modelLabels("opus", "claude-opus-5-5", live).showSession, false);
  assert.equal(modelLabels("opus[1m]", "claude-opus-5-5", live, "opus").showSession, false);
  assert.equal(modelLabels("opus", "claude-opus-5-5[1m]", live, null).showSession, false);
  assert.equal(modelLabels("sonnet", "claude-opus-5-5", live, "opus").showSession, true);
  assert.equal(modelLabels("sonnet", "claude-opus-5-5", live, "opus").actual, "Opus 5.5");
  assert.equal(modelLabels("", "claude-opus-5-5", live, "opus").showSession, false);
});
test("1M comes from the report or the configured model, and is never invented", () => {
  assert.equal(sessionModel("claude-opus-5-5", "opus", live), "claude-opus-5-5");
  assert.equal(sessionModel("claude-opus-5-5", "opus[1m]", live), "claude-opus-5-5[1m]");
  assert.equal(sessionModel("claude-opus-5-5", "claude-opus-5-5[1m]", live), "claude-opus-5-5[1m]");
  assert.equal(sessionModel("claude-opus-5-5[1m]", undefined, live), "claude-opus-5-5[1m]");
  // A configured 1M model that isn't the reported one says nothing about it.
  assert.equal(sessionModel("claude-opus-5-5", "sonnet[1m]", live), "claude-opus-5-5");
  assert.equal(sessionModel(null, "opus[1m]", live), null);
  assert.equal(modelLabels("opus[1m]", "claude-opus-5-5", live).actual, "Opus 5.5 · 1M");
  assert.equal(modelLabels("opus", "claude-opus-5-5", live).actual, "Opus 5.5");
  assert.equal(modelLabels("opus[1m]", "claude-opus-5-5", live, "opus").actual, "Opus 5.5");
  assert.equal(modelLabels("opus[1m]", "claude-opus-5-5", live, "opus").selectedLabel, "Opus 5.5 · 1M");
});

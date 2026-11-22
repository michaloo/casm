import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProviderDefaults, providerDefaults, defaultProvider } from "../src/provider-defaults.ts";

test("provider defaults are scoped to host and provider and cannot inject environment or system prompts", () => {
  const home = mkdtempSync(join(tmpdir(), "casm-defaults-"));
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ providerDefaults: {
      claude: { model: "claude-opus-5-5", effort: "medium", mode: "auto", env: { SECRET: "no" }, systemPrompt: "ignored" },
      codex: { model: "gpt-6.1-sol", effort: "high", mode: "auto-review" },
    } }));
    assert.deepEqual(providerDefaults(home, "claude"), { model: "claude-opus-5-5", effort: "medium", mode: "auto" });
    assert.deepEqual(providerDefaults(home, "codex"), { model: "gpt-6.1-sol", effort: "high", mode: "auto-review" });
    assert.deepEqual(providerDefaults(home, "pi"), {});
    assert.deepEqual(providerDefaults(null, "claude"), {});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("mode survives a model change while an explicit mode takes precedence", () => {
  const defaults = { model: "gpt-6.1-sol", effort: "high", mode: "auto-review" };
  assert.deepEqual(applyProviderDefaults(defaults, { model: "other", mode: "" }), { model: "other", mode: "auto-review" });
  assert.deepEqual(applyProviderDefaults(defaults, { mode: "plan" }), { ...defaults, mode: "plan" });
});

test("new agents inherit defaults while explicit selections win and other models do not inherit effort", () => {
  const defaults = { model: "gpt-6.1-sol", effort: "high" };
  assert.deepEqual(applyProviderDefaults(defaults), defaults);
  assert.deepEqual(applyProviderDefaults(defaults, { model: "", effort: "" }), defaults);
  assert.deepEqual(applyProviderDefaults(defaults, { effort: "low" }), { model: "gpt-6.1-sol", effort: "low" });
  assert.deepEqual(applyProviderDefaults(defaults, { model: "other" }), { model: "other" });
  assert.deepEqual(applyProviderDefaults(defaults, { model: "other", effort: "medium" }), { model: "other", effort: "medium" });
});

test("CLI default provider follows this host configuration and keeps the legacy fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "casm-default-provider-"));
  try {
    assert.equal(defaultProvider(home), "claude");
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaultProvider: "codex" }));
    assert.equal(defaultProvider(home), "codex");
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaultProvider: "invalid" }));
    assert.equal(defaultProvider(home), "claude");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

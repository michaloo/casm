import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  askUserQuestionInput,
  askUserQuestionRequest,
  elicitationRequest,
  elicitationResult,
  parseCatalog,
} from "../src/providers/claude.ts";

// Shape of a real AskUserQuestion tool input.
const ask = {
  questions: [
    {
      question: "Which color should I use?",
      header: "Color",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Blue", description: "Cool" },
      ],
      multiSelect: false,
    },
    {
      question: "Which features do you want?",
      header: "Features",
      options: [
        { label: "Auth", description: "" },
        { label: "Search", description: "Full text" },
        { label: "Export", description: "CSV" },
      ],
      multiSelect: true,
    },
  ],
};

test("maps AskUserQuestion to a question request", () => {
  assert.deepEqual(askUserQuestionRequest("toolu_1", ask), {
    id: "toolu_1",
    prompts: [
      {
        id: "q0",
        text: "Which color should I use?",
        header: "Color",
        kind: "select",
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue", description: "Cool" },
        ],
        multiple: undefined,
        allowOther: true,
      },
      {
        id: "q1",
        text: "Which features do you want?",
        header: "Features",
        kind: "select",
        options: [
          { label: "Auth", description: undefined },
          { label: "Search", description: "Full text" },
          { label: "Export", description: "CSV" },
        ],
        multiple: true,
        allowOther: true,
      },
    ],
  });
});

test("maps answers back to the AskUserQuestion input, keyed by question text", () => {
  const input = askUserQuestionInput(ask, { q0: "Blue", q1: ["Auth", "Export"] });
  assert.deepEqual(input.questions, ask.questions);
  assert.deepEqual(input.answers, {
    "Which color should I use?": "Blue",
    "Which features do you want?": "Auth, Export",
  });
  // Free text and unanswered prompts.
  assert.deepEqual(askUserQuestionInput(ask, { q0: "Green please" }).answers, { "Which color should I use?": "Green please" });
});

const form = {
  serverName: "deploy",
  message: "Confirm the deployment",
  mode: "form" as const,
  requestedSchema: {
    type: "object",
    properties: {
      env: { type: "string", title: "Environment", enum: ["staging", "prod"] },
      replicas: { type: "integer", description: "How many", default: 2 },
      notify: { type: "boolean", title: "Notify team" },
      tags: { type: "array", items: { enum: ["a", "b"] } },
      note: { type: "string" },
    },
    required: ["env", "replicas"],
  },
};

test("maps an MCP form elicitation to prompts and back", () => {
  const req = elicitationRequest("e1", form);
  assert.equal(req.title, "deploy: Confirm the deployment");
  assert.deepEqual(
    req.prompts.map((p) => [p.id, p.kind, p.text, p.multiple]),
    [
      ["env", "select", "Environment", undefined],
      ["replicas", "text", "replicas: How many", undefined],
      ["notify", "confirm", "Notify team (optional)", undefined],
      ["tags", "select", "tags (optional)", true],
      ["note", "text", "note (optional)", undefined],
    ],
  );
  assert.equal(req.prompts[1]!.placeholder, "2");
  assert.deepEqual(elicitationResult(form, { env: "prod", replicas: "3", notify: true, tags: ["a"], note: "" }), {
    action: "accept",
    content: { env: "prod", replicas: 3, notify: true, tags: ["a"] },
  });
  assert.deepEqual(elicitationResult(form, null), { action: "decline" });
});

test("maps a URL elicitation to a confirm prompt", () => {
  const url = { serverName: "gh", message: "Sign in", mode: "url" as const, url: "https://example.com/auth" };
  assert.deepEqual(elicitationRequest("e2", url).prompts, [{ id: "url", kind: "confirm", text: "Sign in\nhttps://example.com/auth" }]);
  assert.deepEqual(elicitationResult(url, { url: true }), { action: "accept" });
  assert.deepEqual(elicitationResult(url, { url: false }), { action: "decline" });
});

// Trimmed from a real supportedModels() result (claude 2.1.292).
const models: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAutoMode: true,
  },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
];

test("parses the model catalog", () => {
  const c = parseCatalog(models);
  assert.deepEqual(c.models, [
    {
      id: "default",
      name: "Default (recommended)",
      description: "Opus 5.5 · Best for everyday, complex tasks",
      isDefault: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "sonnet",
      name: "Sonnet 5.5",
      description: "Most efficient for simpler tasks",
      isDefault: undefined,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    { id: "haiku", name: "Haiku 4.5", description: "Fastest for quick answers", isDefault: undefined, efforts: undefined },
  ]);
  assert.deepEqual(
    c.modes.map((m) => m.id),
    ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  );
  assert.equal(parseCatalog(models.slice(2)).modes.length, 5);
});

test("maps live Claude rate windows without losing fractional percentages or zero reset times", async () => {
  const { rateLimitWindow } = await import("../src/providers/claude.ts");
  for (const rateLimitType of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"] as const) {
    for (const [status, expected] of [["allowed", "ok"], ["allowed_warning", "warning"], ["rejected", "exhausted"]] as const) {
      const window = rateLimitWindow({ rateLimitType, status, utilization: 0.12345, resetsAt: 0 });
      assert.equal(window.id, rateLimitType);
      assert.equal(window.usedPercent, 12.345);
      assert.equal(window.resetsAt, "1970-01-01T00:00:00.000Z");
      assert.equal(window.status, expected);
      assert.ok(window.label);
    }
  }
});

test("Claude account limits map percentages and optional windows, and fail closed on unavailable or malformed responses", async () => {
  const { queryLimits } = await import("../src/providers/claude.ts");
  const response = { subscription_type: "max", rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 15.5, resets_at: "2026-10-13T20:00:00+00:00" },
    seven_day: { utilization: 85, resets_at: null }, seven_day_opus: null,
    seven_day_sonnet: { utilization: null, resets_at: null },
    extra_usage: { is_enabled: true, utilization: 100 },
  } };
  const result = await queryLimits(async () => response);
  assert.equal(result?.plan, "max");
  assert.deepEqual(result?.windows.map((w) => [w.id, w.usedPercent, w.status]), [
    ["five_hour", 15.5, "ok"], ["seven_day", 85, "warning"], ["seven_day_sonnet", undefined, undefined], ["overage", 100, "exhausted"],
  ]);
  assert.equal(await queryLimits(async () => { throw new Error("SDK unavailable"); }), null);
  for (const value of [null, {}, [], { ...response, rate_limits_available: false }, { ...response, rate_limits: null },
    { ...response, rate_limits: { five_hour: { utilization: "15", resets_at: null } } },
    { ...response, rate_limits: { five_hour: { utilization: NaN, resets_at: null } } },
    { ...response, rate_limits: { five_hour: { utilization: 10, resets_at: "bad date" } } }]) {
    assert.equal(await queryLimits(async () => value), null);
  }
});

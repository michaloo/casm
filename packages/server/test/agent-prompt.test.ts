import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPrompt, DEFAULT_AGENT_PROMPT, fill, type PromptVars } from "../src/agent-prompt.ts";

const vars: PromptVars = { host: "box", agentId: "a1", agentName: "Fixer", project: "web", cwd: "/w", provider: "codex", casmTools: null };

test("placeholders are filled per agent; the casm tools line only when it has them", () => {
  const plain = fill(DEFAULT_AGENT_PROMPT, vars);
  assert.match(plain, /on host box\./);
  assert.match(plain, /agent "Fixer" \(id a1, codex\) in project web, working in \/w\./);
  assert.doesNotMatch(plain, /\{\{|MCP/);
  assert.ok(plain.split("\n").length <= 25, "the default stays short");
  // Messages go now (queued or steered); later is a schedule.
  const send = plain.split("\n").find((l) => l.includes("casm send"))!;
  assert.match(send, /queued.*--steer/);
  assert.doesNotMatch(send, /--at/);
  assert.match(plain.split("\n").find((l) => l.includes("casm schedule add"))!, /--at 18:30.*--at "in 2h".*--every.*--cron/);
  const tools = fill(DEFAULT_AGENT_PROMPT, { ...vars, casmTools: ["list_agents", "send"] });
  assert.match(tools, /casm MCP tools .*: list_agents, send\./);
  // Unknown placeholders stay as written.
  assert.equal(fill("{{agentId}} {{nope}}", vars), "a1 {{nope}}");
});

test("agent-prompt.md replaces the default, config.json turns it off, reset deletes the file", () => {
  const home = mkdtempSync(join(tmpdir(), "casm-prompt-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ listen: "127.0.0.1:1" }));
  const p = new AgentPrompt(home);
  assert.deepEqual(p.state(), { enabled: true, content: DEFAULT_AGENT_PROMPT, custom: false, path: join(home, "agent-prompt.md") });
  assert.ok(!existsSync(join(home, "agent-prompt.md")), "reading creates nothing");

  p.set({ content: "Agent {{agentName}} on {{host}}." });
  assert.equal(p.render(vars), "Agent Fixer on box.");
  assert.equal(p.state().custom, true);

  p.set({ enabled: false });
  assert.equal(p.render(vars), null);
  // Other settings are kept.
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { listen: "127.0.0.1:1", agentPrompt: false });

  p.set({ enabled: true, content: null });
  assert.ok(!existsSync(join(home, "agent-prompt.md")));
  assert.equal(p.render(vars), fill(DEFAULT_AGENT_PROMPT, vars));

  assert.throws(() => new AgentPrompt(null).set({ enabled: false }), /no state directory/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { providerEnv } from "../src/providers/env.ts";

test("provider children do not inherit the service's NODE_ENV", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const env = providerEnv({ CASM_AGENT_ID: "test-agent" });
    const output = execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({ mode: process.env.NODE_ENV ?? null, agent: process.env.CASM_AGENT_ID }))"], { env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { mode: null, agent: "test-agent" });
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(providerEnv({ NODE_ENV: "test" }).NODE_ENV, "test");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

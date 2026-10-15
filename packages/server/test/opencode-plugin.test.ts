import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/providers/opencode-plugin.ts";

type Hooks = {
  "shell.env"(input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }): Promise<void>;
};

// A fake OpenCode server answers GET /session/:id with the session's parent.
test("casm's OpenCode plugin: per-session env, inherited by child sessions", async (t) => {
  const http = createServer((req, res) => {
    const id = new URL(req.url!, "http://x").pathname.split("/").pop();
    const parents: Record<string, string> = { ses_child: "ses_parent", ses_grandchild: "ses_child" };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(parents[id!] ? { parentID: parents[id!] } : {}));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => http.close());
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  const dir = mkdtempSync(join(tmpdir(), "casm-oc-plugin-"));
  writeFileSync(join(dir, "ses_parent.json"), JSON.stringify({ env: { CASM_AGENT_ID: "a1" } }));
  process.env.CASM_OPENCODE_STATE = dir;
  const hooks = (await plugin({ serverUrl: new URL(base), directory: "/p" })) as unknown as Hooks;
  // Hidden from agents' commands, still known to later loads (other directories).
  assert.equal(process.env.CASM_OPENCODE_STATE, undefined);
  assert.ok("shell.env" in (await plugin({ serverUrl: new URL(base), directory: "/q" })));

  const env = async (sessionID?: string) => {
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"]({ cwd: "/p", sessionID }, output);
    return output.env;
  };
  assert.deepEqual(await env("ses_parent"), { CASM_AGENT_ID: "a1" });
  assert.deepEqual(await env("ses_grandchild"), { CASM_AGENT_ID: "a1" });
  assert.deepEqual(await env("ses_unknown"), {});
  assert.deepEqual(await env(undefined), {});
  assert.deepEqual(await env("../etc/passwd"), {});
  // No tools of its own: agents use the casm CLI.
  assert.deepEqual(Object.keys(hooks), ["shell.env"]);
});

test("casm's OpenCode plugin does nothing outside casm", async () => {
  delete (globalThis as { casmOpencodeState?: string }).casmOpencodeState;
  assert.deepEqual(await plugin({ serverUrl: new URL("http://127.0.0.1:1"), directory: "/" }), {});
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/providers/opencode-plugin.ts";
import { CASM_TOOLS } from "../src/mcp.ts";

type Hooks = {
  tool: Record<string, { description: string; args: Record<string, unknown>; execute(args: Record<string, unknown>, ctx: { sessionID: string; directory: string }): Promise<string> }>;
  "shell.env"(input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }): Promise<void>;
};

// One fake HTTP server plays both OpenCode (GET /session/:id) and casm's MCP endpoint.
test("casm's OpenCode plugin: per-session env and casm tools, inherited by child sessions", async (t) => {
  const calls: { auth?: string; body: { params: { name: string; arguments: Record<string, unknown> } } }[] = [];
  const http = createServer(async (req, res) => {
    if (req.method === "GET") {
      const id = new URL(req.url!, "http://x").pathname.split("/").pop();
      const parents: Record<string, string> = { ses_child: "ses_parent", ses_grandchild: "ses_child" };
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(parents[id!] ? { parentID: parents[id!] } : {}));
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ auth: req.headers.authorization, body });
    const isError = body.params.name === "wait";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: isError ? "no agent" : "ok" }], ...(isError ? { isError } : {}) } }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => http.close());
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  const dir = mkdtempSync(join(tmpdir(), "casm-oc-plugin-"));
  writeFileSync(join(dir, "tools.json"), JSON.stringify(CASM_TOOLS));
  writeFileSync(join(dir, "ses_parent.json"), JSON.stringify({ env: { CASM_AGENT_ID: "a1" }, casm: { url: `${base}/mcp`, token: "tok" } }));
  writeFileSync(join(dir, "ses_plain.json"), JSON.stringify({ env: { CASM_AGENT_ID: "a2" } }));
  process.env.CASM_OPENCODE_STATE = dir;
  const hooks = (await plugin({ serverUrl: new URL(base), directory: "/p" })) as unknown as Hooks;
  // Hidden from agents' commands, still known to later loads (other directories).
  assert.equal(process.env.CASM_OPENCODE_STATE, undefined);
  assert.ok(Object.keys(((await plugin({ serverUrl: new URL(base), directory: "/q" })) as unknown as Hooks).tool).length);

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

  // Every casm MCP tool, optional args nullable.
  assert.deepEqual(Object.keys(hooks.tool).sort(), CASM_TOOLS.map((x) => `casm_${x.name}`).sort());
  const send = hooks.tool.casm_send;
  assert.ok(send.args.agent && !("anyOf" in (send.args.agent as object)));
  assert.ok("anyOf" in (send.args.host as object));
  assert.equal(await send.execute({ agent: "x", text: "hi", host: null }, { sessionID: "ses_child", directory: "/p" }), "ok");
  assert.deepEqual(calls[0], { auth: "Bearer tok", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: { agent: "x", text: "hi" } } } });
  await assert.rejects(hooks.tool.casm_wait.execute({ agent: "x" }, { sessionID: "ses_parent", directory: "/p" }), /no agent/);
  await assert.rejects(send.execute({ agent: "x", text: "hi" }, { sessionID: "ses_plain", directory: "/p" }), /not enabled/);
});

test("casm's OpenCode plugin does nothing outside casm", async () => {
  delete (globalThis as { casmOpencodeState?: string }).casmOpencodeState;
  assert.deepEqual(await plugin({ serverUrl: new URL("http://127.0.0.1:1"), directory: "/" }), {});
});

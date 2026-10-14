import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider, ProviderSession } from "../src/providers/types.ts";
import { codexMcpServer, opencodeMcpServers } from "../src/providers/mcp.ts";

for (const mode of ["native", "fallback", "old-native"] as const) test(`MCP ${mode}: idle session, status, one/all reconnect and CLI`, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "casm-mcp-test-"));
  const store = new Store(join(home, "test.db"));
  let opened = 0, closed = 0;
  const reconnected: (string | undefined)[] = [];
  let enabled = true;
  const unsupported = () => { throw Object.assign(new Error("method not found"), { code: -32601 }); };
  const provider: Provider = {
    id: "claude", history: async () => [], usage: async () => null, commands: async () => [], catalog: async () => ({ models: [], modes: [] }),
    open(opts) {
      opened++;
      setImmediate(() => opts.emit({ type: "sessionId", id: opts.resumeId ?? "native-mcp" }));
      const session: ProviderSession = { send() {}, shell() {}, async interrupt() {}, async close() { closed++; } };
      if (mode !== "fallback") Object.assign(session, {
        mcpStatus: async () => mode === "old-native" ? unsupported() : [{ name: "docs", status: enabled ? "connected" : "disabled", tools: 3 }],
        mcpReconnect: async (server?: string) => { if (mode === "old-native") unsupported(); reconnected.push(server); if (server === "broken") throw new Error("connection refused"); return `reconnected ${server ?? "all"}`; },
        mcpToggle: async (_server: string, value: boolean) => { enabled = value; },
      });
      return session;
    },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", home });
  const token = store.createToken("test");
  const client = await CasmClient.connect(server.url, token);
  t.after(async () => { client.close(); await server.close(); store.close(); await rm(home, { recursive: true, force: true }); });
  const project = await client.call("project.create", { name: "test", path: home });
  const agent = await client.call("agent.create", { projectId: project.id, provider: "claude", name: "MCP test" });
  const status = await client.call("agent.mcpStatus", { id: agent.id });
  assert.equal(opened, 1);
  if (mode === "native") {
    assert.deepEqual(status, { servers: [{ name: "docs", status: "connected", tools: 3 }], reconnect: "server", canToggle: true });
    assert.equal((await client.call("agent.mcpReconnect", { id: agent.id, server: "docs" })).mode, "native");
    await client.call("agent.mcpReconnect", { id: agent.id });
    assert.deepEqual(reconnected, ["docs", undefined]);
    assert.equal(closed, 0);
    await client.call("agent.mcpToggle", { id: agent.id, server: "docs", enabled: false });
    assert.equal((await client.call("agent.mcpStatus", { id: agent.id })).servers[0].status, "disabled");
    await assert.rejects(client.call("agent.mcpReconnect", { id: agent.id, server: "broken" }), /connection refused/);
    assert.equal(closed, 0, "a real reconnect failure must not restart the session");
  } else {
    assert.equal(status.reconnect, "reload");
    const result = await client.call("agent.mcpReconnect", { id: agent.id, server: "docs" });
    assert.equal(result.mode, "reload"); assert.match(result.message, /whole agent session/);
    assert.equal(closed, 1); assert.equal(opened, 2);
    if (mode === "fallback") await assert.rejects(client.call("agent.mcpToggle", { id: agent.id, server: "docs", enabled: false }), /does not support/);
  }
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [resolve("packages/cli/src/main.ts"), "--json", "mcp", agent.id, ...args], { env: { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "" } })).stdout);
  assert.ok(Array.isArray((await cli()).servers));
  assert.equal((await cli("--reconnect", "docs")).mode, mode === "native" ? "native" : "reload");
  assert.equal((await cli("--reconnect")).mode, mode === "native" ? "native" : "reload");
  await client.call("agent.update", { id: agent.id, archived: true });
  await assert.rejects(client.call("agent.mcpStatus", { id: agent.id }), /archived/);
});

test("native MCP status normalization preserves failed/auth/pending states and unknown tool counts", () => {
  assert.deepEqual(codexMcpServer({ name: "docs", runtimeStatus: "connected", tools: { lookup: {} } }), { name: "docs", status: "connected", tools: 1 });
  assert.equal(codexMcpServer({ name: "docs", runtimeStatus: "authenticationRequired" }).status, "needs-auth");
  assert.equal(codexMcpServer({ name: "docs", runtimeStatus: "starting" }).status, "pending");
  assert.equal(codexMcpServer({ name: "docs", toolsError: "failed" }).error, "failed");
  assert.equal(codexMcpServer({ name: "docs", tools: {} }).status, "pending");
  assert.deepEqual(opencodeMcpServers({ docs: { status: "needs_client_registration", error: "register first" } }), [{ name: "docs", status: "needs-auth", tools: 0, toolsKnown: false, error: "register first" }]);
});

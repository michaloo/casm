import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CasmClient } from "@casm/client";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

test("casm send --wait exits 4 when a usage limit defers the message, like run --wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-send-wait-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const provider: Provider = {
    id: "codex",
    open(opts) {
      setImmediate(() => opts.emit({ type: "sessionId", id: "native" }));
      return {
        send() { setImmediate(() => opts.emit({ type: "turnEnded", outcome: "failed", error: "429 usage limit exceeded" })); },
        shell() {}, async interrupt() {}, async close() {},
      };
    },
    async history() { return []; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
    async limits() { return null; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const p = await client.call("project.create", { path: dir });
    const a = await client.call("agent.create", { projectId: p.id, provider: "codex" });
    await client.call("agent.send", { id: a.id, text: "trip the limit" });
    await client.call("agent.wait", { id: a.id });
    assert.ok((await client.call("agent.get", { id: a.id })).deferred);
    const cli = join(import.meta.dirname, "../../cli/src/main.ts");
    const env = { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "" };
    const sent = await promisify(execFile)(process.execPath, [cli, "send", a.id, "--wait", "after the limit"], { env }).then(() => 0, (e) => e.code);
    assert.equal(sent, 4);
    const plain = await promisify(execFile)(process.execPath, [cli, "send", a.id, "no wait"], { env }).then(() => 0, (e) => e.code);
    assert.equal(plain, 0);
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

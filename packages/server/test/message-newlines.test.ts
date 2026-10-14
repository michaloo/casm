import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient } from "@casm/client";
import type { Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import type { Provider } from "../src/providers/types.ts";

test("human and interagent actual newlines and literal escapes survive live and history payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-message-newlines-"));
  const store = new Store(join(dir, "db"));
  const token = store.createToken("test");
  const history: Item[] = [];
  const provider: Provider = {
    id: "claude",
    open(opts) {
      opts.emit({ type: "sessionId", id: "newline-session" });
      return {
        send(text, id) {
          history.push({ kind: "user", id, text });
          setImmediate(() => opts.emit({ type: "turnEnded", outcome: "completed" }));
        },
        shell() {}, async interrupt() {}, async close() {},
      };
    },
    async history() { return history; }, async usage() { return null; },
    async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  };
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test" });
  const client = await CasmClient.connect(server.url, token);
  try {
    const project = await client.call("project.create", { path: dir });
    const agent = await client.call("agent.create", { projectId: project.id, provider: "claude" });
    const live: Item[] = [];
    client.on("agent.event", ({ event }) => {
      if (event.type === "item" && event.item.kind === "user") live.push(event.item);
    });
    await client.call("agent.subscribe", { id: agent.id });
    const text = "First line\nSecond line\n\nLiteral \\n stays literal\n```text\ncode one\ncode two\n```";
    const sender = { serverId: "source-server", agentId: "source-agent", name: "Reporter" };
    for (const origin of [undefined, sender]) {
      await client.call("agent.send", { id: agent.id, text, sender: origin });
      await client.call("agent.wait", { id: agent.id });
    }
    assert.deepEqual(live.map((item) => item.kind === "user" && [item.text, item.sender]), [[text, undefined], [text, sender]]);
    const saved = (await client.call("agent.history", { id: agent.id })).items;
    assert.deepEqual(saved.map((item) => item.kind === "user" && [item.text, item.sender]), [[text, undefined], [text, sender]]);
  } finally {
    client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

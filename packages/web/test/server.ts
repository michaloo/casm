// Disposable real casm server with a deterministic provider. No production state or model calls.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../server/src/db.ts";
import { startServer } from "../../server/src/server.ts";
import type {
  Provider,
  OpenOptions,
} from "../../server/src/providers/types.ts";
import type { Item } from "@casm/protocol";
const home = process.env.CASM_DEV_HOME;
if (home !== "/tmp/casm-web-dev" || process.env.CASM_DEV_PORT !== "7495")
  throw new Error(
    "Use isolated CASM_DEV_HOME=/tmp/casm-web-dev CASM_DEV_PORT=7495",
  );
mkdirSync(home, { recursive: true });
rmSync(`${home}/web-test.db`, { force: true });
const store = new Store(`${home}/web-test.db`);
writeFileSync(`${home}/web-token`, store.createToken("web-test"));
const history: Item[] = Array.from({ length: 320 }, (_, i) => ({
  kind: i % 2 ? "assistant" : "user",
  id: `history-${i}`,
  text: `Message ${i}\n\nA focused conversation with enough history to scroll.\n\n${"More context. ".repeat(10)}`,
}));
let seq = 0;
const histories = new Map<string, Item[]>();
const provider: Provider = {
  id: "claude",
  history: async (id) => histories.get(id) ?? [],
  catalog: async () => ({
    models: [{ id: "haiku", name: "Haiku" }],
    modes: [{ id: "default" }],
  }),
  usage: async () => null,
  commands: async () => [],
  open(o: OpenOptions) {
    const abort = new AbortController();
    const sessionId = o.resumeId ?? `new-${++seq}`;
    o.emit({ type: "sessionId", id: sessionId });
    let timer: ReturnType<typeof setInterval> | undefined;
    return {
      send(text) {
        void (async () => {
          if (text === "permission")
            await o.askPermission(
              {
                id: "permission",
                toolName: "Write",
                input: { path: "example.txt" },
                canAlwaysAllow: true,
              },
              abort.signal,
            );
          if (text === "question")
            await o.askQuestion(
              {
                id: "question",
                prompts: [
                  {
                    id: "color",
                    text: "Choose color",
                    kind: "select",
                    options: [{ label: "Blue" }],
                  },
                ],
              },
              abort.signal,
            );
          if (text === "stream") {
            let n = 0;
            timer = setInterval(() => {
              o.emit({
                type: "delta",
                kind: "assistant",
                text: `Streaming line ${n++}\n\n`,
              });
            }, 70);
            return;
          }
          if (text === "slow") return;
          const reply: Item = {
            kind: "assistant",
            id: `reply-${++seq}`,
            text: `echo: ${text}`,
          };
          histories.set(sessionId, [
            ...(histories.get(sessionId) ?? []),
            reply,
          ]);
          o.emit({ type: "item", item: reply });
          if (text !== "steered")
            o.emit({ type: "turnEnded", outcome: "completed" });
        })().catch(() => {});
      },
      shell() {},
      async interrupt() {
        clearInterval(timer);
        abort.abort();
        o.emit({ type: "turnEnded", outcome: "interrupted" });
      },
      async close() {
        clearInterval(timer);
        abort.abort();
      },
    };
  },
};
const p = store.createProject({ name: "Test project", path: home });
for (let i = 0; i < 65; i++) {
  const a = store.createAgent({
    projectId: p.id,
    name: `Agent ${String(i).padStart(2, "0")}`,
    provider: "claude",
    cwd: home,
    config: {},
  });
  histories.set(`fake-history-${i}`, [...history]);
  store.updateAgent(a.id, { nativeSessionId: `fake-history-${i}` });
}
const server = await startServer({
  store,
  providers: [provider],
  host: "127.0.0.1",
  port: 7495,
  version: "web-test",
  name: "Test host",
  home,
  webRoot: resolve("packages/web/dist"),
});
const sockets = new Set<import("node:stream").Duplex>();
server.http.on("upgrade", (_request, socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
writeFileSync(`${home}/web-pid`, String(process.pid));
process.on("SIGUSR2", () => {
  for (const socket of sockets) socket.destroy();
});
console.log(`Web test server ${server.url}`);
process.on(
  "SIGTERM",
  () =>
    void server.close().then(() => {
      store.close();
      process.exit();
    }),
);

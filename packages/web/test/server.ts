// Disposable real casm server with a deterministic provider. No production state or model calls.
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../server/src/db.ts";
import { startServer } from "../../server/src/server.ts";
import type {
  Provider,
  OpenOptions,
} from "../../server/src/providers/types.ts";
import type { Item } from "@casm/protocol";
import { visualItems } from "./visual-fixture.ts";
import { scrollItems } from "./scroll-fixture.ts";
import { testHome as home, testPort } from "./config.ts";
mkdirSync(home, { recursive: true });
rmSync(`${home}/web-test.db`, { force: true });
rmSync(`${home}/push-sent.jsonl`, { force: true });
// Global settings must never reach the account running this fixture.
const settings = `${home}/host-settings`;
rmSync(settings, { recursive: true, force: true });
mkdirSync(settings, { recursive: true });
writeFileSync(`${settings}/AGENTS.md`, "# Shared host instructions\n\nUse isolated fixtures.\n");
for (const [key, folder, name] of [
  ["CLAUDE_CONFIG_DIR", "claude", "CLAUDE.md"],
  ["CODEX_HOME", "codex", "AGENTS.md"],
  ["XDG_CONFIG_HOME", "config/opencode", "AGENTS.md"],
  ["PI_CODING_AGENT_DIR", "pi", "AGENTS.md"],
]) {
  mkdirSync(`${settings}/${folder}`, { recursive: true });
  symlinkSync(`${settings}/AGENTS.md`, `${settings}/${folder}/${name}`);
  process.env[key] = `${settings}/${key === "XDG_CONFIG_HOME" ? "config" : folder}`;
}
mkdirSync(`${home}/state`, { recursive: true });
process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
const store = new Store(`${home}/web-test.db`);
writeFileSync(`${home}/web-token`, store.createToken("web-test"));
const history: Item[] = Array.from({ length: 320 }, (_, i) => ({
  kind: i % 2 ? "assistant" : "user",
  id: `history-${i}`,
  // A day of history, 37s apart: dated entries that are not today.
  at: new Date(Date.UTC(2026, 9, 14, 8, 0, 0) + i * 37_000).toISOString(),
  text: `Message ${i}\n\nA focused conversation with enough history to scroll.\n\n${"More context. ".repeat(10)}`,
}));
let seq = 0;
const failedOnce = new Set<string>();
const histories = new Map<string, Item[]>();
const provider: Provider = {
  id: "claude",
  history: async (id) => histories.get(id) ?? [],
  catalog: async () => ({
    models: [{ id: "haiku", name: "Haiku" }],
    modes: [{ id: "default" }],
  }),
  memories: async (cwd) => ({ scope: "project", location: `${cwd}/memory`, entries: [
    { id: "workflow", title: "Project workflow", description: "How this project is maintained", text: "# Workflow details\n\nUse **isolated** tests." },
  ] }),
  usage: async () => null,
  commands: async () => [
    { name: "review", description: "Review the requested files and explain the findings", argumentHint: "<path>", kind: "command" },
    { name: "audit", description: "Run a careful project audit with readable descriptions on phones", argumentHint: "[scope]", kind: "skill" },
    { name: "reload", description: "Provider command sharing a casm name", kind: "command" },
  ],
  open(o: OpenOptions) {
    const abort = new AbortController();
    const sessionId = o.resumeId ?? `new-${++seq}`;
    o.emit({ type: "sessionId", id: sessionId });
    let timer: ReturnType<typeof setInterval> | undefined;
    let mcpEnabled = true;
    let mcpFailed = true;
    return {
      mcpStatus: async () => [
        { name: "docs", status: !mcpEnabled ? "disabled" as const : mcpFailed ? "failed" as const : "connected" as const, tools: mcpEnabled && !mcpFailed ? 3 : 0, ...(mcpFailed ? { error: "Connection needs a refresh" } : {}) },
        { name: "auth", status: "needs-auth" as const, tools: 0 },
      ],
      async mcpReconnect() { mcpFailed = false; return "MCP servers reconnected."; },
      async mcpToggle(_name: string, enabled: boolean) { mcpEnabled = enabled; },
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
          // A turn whose rows keep growing after they mount: Thinking, a
          // running tool with streaming output, then a streamed reply.
          if (text === "grow") {
            const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 8; i++) { o.emit({ type: "delta", kind: "reasoning", text: `Thinking about step ${i}. ` + "Weighing the options. ".repeat(4) + "\n\n" }); await wait(50); }
            o.emit({ type: "item", item: { kind: "reasoning", id: `grow-think-${++seq}`, text: "Planned the run." } });
            const tool = { kind: "tool" as const, id: `grow-tool-${++seq}`, name: "Bash", input: { command: "npm test --workspace @casm/web" }, status: "running" as const, output: "" };
            o.emit({ type: "item", item: tool });
            for (let i = 0; i < 14; i++) { o.emit({ type: "toolOutput", itemId: tool.id, text: `  ✓ check ${i} passed\n` }); await wait(60); }
            o.emit({ type: "item", item: { ...tool, status: "done", output: Array.from({ length: 14 }, (_, i) => `  ✓ check ${i} passed`).join("\n") } });
            for (let i = 0; i < 10; i++) { o.emit({ type: "delta", kind: "assistant", text: `Result line ${i}: ` + "all good. ".repeat(6) + "\n\n" }); await wait(50); }
            o.emit({ type: "item", item: { kind: "assistant", id: `grow-reply-${++seq}`, text: Array.from({ length: 10 }, (_, i) => `Result line ${i}: ` + "all good. ".repeat(6)).join("\n\n") + "\n\ngrow done" } });
            o.emit({ type: "turnEnded", outcome: "completed" });
            return;
          }
          // The provider is unreachable the first time this text is sent.
          if (text.startsWith("unavailable") && !failedOnce.has(text)) {
            failedOnce.add(text);
            o.emit({ type: "turnEnded", outcome: "failed", error: "provider unreachable" });
            return;
          }
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
const visualPath = `${home}/visual`;
mkdirSync(visualPath, { recursive: true });
const visualProject = store.createProject({
  name: "Design review",
  path: visualPath,
});
const visual = store.createAgent({
  projectId: visualProject.id,
  name: "Visual review",
  provider: "claude",
  cwd: home,
  config: {},
});
histories.set("visual-history", visualItems);
store.updateAgent(visual.id, { nativeSessionId: "visual-history" });
const long = store.createAgent({ projectId: visualProject.id, name: "Long mixed", provider: "claude", cwd: home, config: {} });
histories.set("long-history", scrollItems());
store.updateAgent(long.id, { nativeSessionId: "long-history" });
const archived = store.createAgent({
  projectId: p.id,
  name: "Archived agent",
  provider: "claude",
  cwd: home,
  config: {},
});
store.updateAgent(archived.id, { archived: true });
writeFileSync(`${home}/web-archived-id`, archived.id);
// Files agents "created", mentioned in prose, inline code and tool output.
const exportsDir = `${home}/exports`;
rmSync(exportsDir, { recursive: true, force: true });
mkdirSync(`${exportsDir}/nested`, { recursive: true });
writeFileSync(`${exportsDir}/cykelhuset-web-merge.json`, JSON.stringify({ merged: [{ id: 1, name: "Cykelhuset" }], ok: true }));
writeFileSync(`${exportsDir}/notes.md`, "# Import notes\n\nAll **rows** merged.\n");
writeFileSync(`${exportsDir}/pixel.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
writeFileSync(`${exportsDir}/blob.bin`, Buffer.from([0, 1, 2, 3]));
writeFileSync(`${exportsDir}/lines.ts`, Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n");
writeFileSync(`${exportsDir}/page.html`, `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1 id="hi">Rendered page</h1><script>document.getElementById("hi").dataset.js = "ran"; try { window.parent.document.title; document.title = "reached"; } catch (e) { document.getElementById("hi").dataset.blocked = "yes"; }</script></body></html>`);
writeFileSync(`${exportsDir}/nested/deep.txt`, "deep\n");
writeFileSync(`${home}/.hidden-config`, "hidden=1\n");
const filesAgent = store.createAgent({ projectId: p.id, name: "Files agent", provider: "claude", cwd: home, config: {} });
histories.set("files-history", [
  { kind: "user", id: "files-ask", text: "Merge the exports" },
  { kind: "tool", id: "files-tool", name: "Bash", status: "done", input: { command: `ls ${exportsDir}` }, output: `${exportsDir}/pixel.png\n${exportsDir}/blob.bin\n` },
  { kind: "assistant", id: "files-reply", text: `Saved the merge to ${exportsDir}/cykelhuset-web-merge.json.\n\nNotes are in \`${exportsDir}/notes.md\`; /etc/passwd was not touched.` },
  { kind: "assistant", id: "files-lines", text: `See ${exportsDir}/lines.ts:40:5 and [the helper](${exportsDir}/lines.ts#L90) or ${exportsDir}/page.html.` },
]);
store.updateAgent(filesAgent.id, { nativeSessionId: "files-history" });
writeFileSync(`${home}/web-files-agent-id`, filesAgent.id);
const server = await startServer({
  store,
  providers: [provider],
  host: "127.0.0.1",
  port: testPort,
  version: "web-test",
  name: "Test host",
  // Inside the project folder: the Files tab lists it but never opens it.
  home: `${home}/state`,
  webRoot: resolve("packages/web/dist"),
  // No real push service: deliveries are recorded; an endpoint containing "gone" has expired.
  pushSend: async (req) => {
    appendFileSync(`${home}/push-sent.jsonl`, JSON.stringify({ endpoint: req.endpoint }) + "\n");
    return { status: req.endpoint.includes("gone") ? 410 : 201, headers: new Headers(), body: "" };
  },
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

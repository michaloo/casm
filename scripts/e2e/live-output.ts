// End-to-end check of live command output against a development server and a
// real provider: an agent runs a slowly printing command in the foreground and
// the tool's output must arrive as toolOutput events while it runs, before its
// final tool item. Makes real model calls; use a cheap model.
//
//   CASM_DEV_PORT=7584 node scripts/e2e/live-output.ts --project <name> \
//     --provider claude --model claude-haiku-4-5-20251001
//
// Writes the timed events to --log (default /tmp/casm-live-output-<provider>.jsonl).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentEvent, ProviderId } from "@casm/protocol";
import { CasmClient } from "../../packages/client/src/index.ts";

const { values: opt } = parseArgs({
  options: {
    project: { type: "string" },
    provider: { type: "string", default: "claude" },
    model: { type: "string" },
    log: { type: "string" },
  },
});
if (!opt.project || !opt.model) throw new Error("--project and --model are required");
const home = process.env.CASM_DEV_HOME || join(import.meta.dirname, "..", "..", ".casm-dev");
const port = Number(process.env.CASM_DEV_PORT ?? 7474);
const { token } = JSON.parse(readFileSync(join(home, "development.json"), "utf8"));
const c = await CasmClient.connect(`ws://127.0.0.1:${port}`, token, { timeoutMs: 5000 });

// Modes that run a shell command without asking.
const MODES: Record<string, string> = { claude: "bypassPermissions", codex: "full-access" };
const { projects } = await c.call("project.list", {});
const project = projects.find((p: { name: string }) => p.name === opt.project) ?? (() => { throw new Error(`no project ${opt.project}`); })();
const agent = await c.call("agent.create", {
  projectId: project.id,
  provider: opt.provider as ProviderId,
  name: `live output e2e (${opt.provider})`,
  config: { model: opt.model, ...(MODES[opt.provider!] ? { mode: MODES[opt.provider!] } : {}) },
});
const t0 = Date.now();
const events: { t: number; event: AgentEvent }[] = [];
c.on("agent.event", ({ agentId, event }: { agentId: string; event: AgentEvent }) => {
  if (agentId === agent.id) events.push({ t: Date.now() - t0, event });
});
await c.call("agent.subscribe", { id: agent.id });
await c.call("agent.send", {
  id: agent.id,
  text: "Run exactly this one shell command in the foreground (not in the background) and then reply with just 'done': for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 1.5; done",
});
const r = await c.call("agent.wait", { id: agent.id, timeoutMs: 180_000 });
const log = opt.log ?? `/tmp/casm-live-output-${opt.provider}.jsonl`;
writeFileSync(log, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

// The command's tool: the one whose output says tick 8.
const done = events.find((e) => e.event.type === "item" && e.event.item.kind === "tool" && e.event.item.status !== "running" && /tick 8/.test(e.event.item.output ?? ""));
if (!done || done.event.type !== "item") throw new Error(`no finished tool printed "tick 8" (status ${r.status}); events in ${log}`);
const id = done.event.item.id;
const deltas = events.filter((e) => e.event.type === "toolOutput" && e.event.itemId === id && e.t < done.t);
const streamed = deltas.map((e) => (e.event as { text: string }).text).join("");
const ticks = [...streamed.matchAll(/tick (\d)/g)].map((m) => Number(m[1]));
console.log(`provider ${opt.provider}, model ${opt.model}; tool ${id} finished at ${done.t} ms`);
for (const d of deltas) console.log(`  ${String(d.t).padStart(6)} ms  +${JSON.stringify((d.event as { text: string }).text)}`);
const ok = deltas.length >= 3 && ticks.length >= 3 && ticks.every((n, i) => i === 0 || n === ticks[i - 1]! + 1) && deltas[0]!.t < done.t - 3000;
console.log(ok ? "PASS: output streamed while the command ran" : "FAIL: no live output before the result");
c.close();
process.exit(ok ? 0 : 1);

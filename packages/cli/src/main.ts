#!/usr/bin/env node
// casm — the casm server (`casm serve`, `casm token`) and its command-line client.
// Client commands take -H/--host and --json.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CasmClient } from "@casm/client";
import type { Agent, AgentEvent, Item, Project, ProviderId, Usage } from "@casm/protocol";

const home = process.env.CASM_HOME ?? join(homedir(), ".casm-ng");
const hostsFile = join(home, "hosts.json");

type Hosts = { default?: string; hosts: Record<string, { url: string; token: string }> };

function readHosts(): Hosts {
  try {
    return JSON.parse(readFileSync(hostsFile, "utf8"));
  } catch {
    return { hosts: {} };
  }
}

function writeHosts(h: Hosts) {
  mkdirSync(home, { recursive: true });
  writeFileSync(hostsFile, JSON.stringify(h, null, 2) + "\n", { mode: 0o600 });
}

const usage = `usage: casm [-H host] [--json] <command>

server (runs on this machine):
  serve [--listen host:port] [--name n]
  token create <name> | token list | token revoke <name>
  peer add <name> <ws-url> <token> | peer list [--probe] | peer rm <name>

hosts (stored in ${hostsFile}):
  host add <name> <ws-url> <token> [--default]
  host list | host rm <name>

projects:
  projects
  project create <dir> [--name n] [--group g] [--tag t]...
  project group <project> [group]     set the project's group; omit it to ungroup
  project rm <project>
  project agents-md <project> [--edit]  print <project>/AGENTS.md; --edit opens $EDITOR and saves
  project memories <project>          each agent's memories for the project folder (--json: full text)

agents:
  agents [--project p] [--all] [--usage]
  run --project p [--provider claude] [--name n] [--model m] [--mode m]
      [--parent serverId/agentId] [--casm-tools] [--wait] <prompt>
  send <agent> <text> [--steer] [--wait] [--fail-if-limited] [--at 18:30|"in 2h"|ISO]
  pending [agent]                    messages waiting for their agent (busy or over a limit),
                                     and agents waiting for a permission or answer

schedules (run on the host; messages to busy or limited agents become pending):
  schedules [--agent a]
  schedule add (--cron "0 9 * * 1-5" | --every 30m | --at 18:30) <prompt>
               (--agent a [--skip-if-busy] | --project p --provider claude [--model m] [--mode m] [--name n])
  schedule run | enable | disable | rm <schedule>
  cancel <agent> [message-id|--all]  cancel pending messages
  wait <agent> [--timeout seconds]
  history <agent> [-n count]
  watch <agent>                      stream live events
  permissions <agent>                list pending permission requests
  questions <agent>                  list pending questions
  answer <agent> <request> <prompt>=<value>...   (repeat a prompt for several choices)
  answer <agent> <request> --dismiss
  models [--provider p] [--refresh]  models and modes each agent offers on the host
  limits [--provider p] [--refresh]  subscription limits per agent (used % per window)
  usage <agent>                      context-window usage and cost of one agent
  approve <agent> <request> [--always]
  deny <agent> <request> [--message text]
  shell <agent> <command>            run a command in the agent's directory (like "!cmd")
  interrupt | reload | restart | archive | rm <agent>

<project> and <agent> accept an id, an id prefix or an exact name.
Environment: CASM_HOST, CASM_URL + CASM_TOKEN override the host list.
Inside a casm agent, CASM_SERVER_ID, CASM_SERVER_NAME and CASM_AGENT_ID are set,
so "casm run" links the new agent to it as parent (override with --parent, or --parent none).`;

const serverSubcommand = ["serve", "token", "peer"].includes(process.argv[2]);

const { values: opt, positionals } = parseArgs({
  args: serverSubcommand ? [] : process.argv.slice(2),
  allowPositionals: true,
  options: {
    host: { type: "string", short: "H" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    default: { type: "boolean" },
    path: { type: "string" },
    parent: { type: "string" },
    tag: { type: "string", multiple: true },
    project: { type: "string", short: "p" },
    all: { type: "boolean" },
    provider: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    wait: { type: "boolean", short: "w" },
    steer: { type: "boolean" },
    timeout: { type: "string" },
    n: { type: "string", short: "n" },
    always: { type: "boolean" },
    message: { type: "string" },
    dismiss: { type: "boolean" },
    group: { type: "string" },
    refresh: { type: "boolean" },
    usage: { type: "boolean" },
    "fail-if-limited": { type: "boolean" },
    at: { type: "string" },
    cron: { type: "string" },
    every: { type: "string" },
    agent: { type: "string" },
    "skip-if-busy": { type: "boolean" },
    "casm-tools": { type: "boolean" },
    edit: { type: "boolean" },
  },
});

const [cmd, ...args] = positionals;

function fail(msg: string): never {
  console.error(`casm: ${msg}`);
  process.exit(1);
}

function out(json: unknown, human: () => void) {
  if (opt.json) console.log(JSON.stringify(json, null, 2));
  else human();
}

async function connect(): Promise<CasmClient> {
  if (process.env.CASM_URL && process.env.CASM_TOKEN) return CasmClient.connect(process.env.CASM_URL, process.env.CASM_TOKEN);
  const h = readHosts();
  const name = opt.host ?? process.env.CASM_HOST ?? h.default ?? Object.keys(h.hosts)[0];
  if (!name) fail(`no hosts configured; run "casm host add <name> <ws-url> <token>"`);
  const host = h.hosts[name];
  if (!host) fail(`unknown host "${name}" (known: ${Object.keys(h.hosts).join(", ") || "none"})`);
  return CasmClient.connect(host.url, host.token);
}

function pick<T extends { id: string; name: string }>(list: T[], ref: string, what: string): T {
  const exact = list.find((x) => x.id === ref || x.name === ref);
  if (exact) return exact;
  const byPrefix = list.filter((x) => x.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  fail(byPrefix.length ? `"${ref}" matches several ${what}s` : `no ${what} "${ref}"`);
}

const shortId = (id: string) => id.slice(0, 8);

// "18:30" (today, or tomorrow if past), "in 2h" / "in 30m", or an ISO time.
function parseWhen(s: string): string {
  const rel = s.match(/^(?:in\s*)?\+?(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)\w*$/i);
  if (rel) return new Date(Date.now() + Number(rel[1]) * ({ m: 6e4, h: 36e5, d: 864e5 }[rel[2][0].toLowerCase() as "m" | "h" | "d"])).toISOString();
  const clock = s.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const t = new Date();
    t.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`can't read the time "${s}" (use 18:30, "in 2h" or an ISO time)`);
  return new Date(t).toISOString();
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

function formatUsage(u: Usage): string {
  const ctx =
    u.contextTokens !== undefined
      ? `ctx ${kTokens(u.contextTokens)}${u.contextWindow ? `/${kTokens(u.contextWindow)} (${Math.round((100 * u.contextTokens) / u.contextWindow)}%)` : ""}`
      : "";
  return [ctx, u.costUsd !== undefined ? `$${u.costUsd.toFixed(2)}` : "", u.model ?? ""].filter(Boolean).join("  ");
}

// `run --parent serverId/agentId`, else the agent this CLI runs inside of.
function runParent(): { serverId: string; agentId: string; host?: string } | undefined {
  if (opt.parent === "none") return undefined;
  if (opt.parent) {
    const [serverId, agentId, ...extra] = opt.parent.split("/");
    if (!serverId || !agentId || extra.length) fail("--parent must be <serverId>/<agentId>");
    return { serverId, agentId };
  }
  const { CASM_SERVER_ID: serverId, CASM_AGENT_ID: agentId, CASM_SERVER_NAME: host } = process.env;
  return serverId && agentId ? { serverId, agentId, host: host || undefined } : undefined;
}

function renderItem(i: Item): string {
  switch (i.kind) {
    case "user":
      return `\n> ${i.text.replaceAll("\n", "\n> ")}${i.images?.length ? `\n> [${i.images.length} image(s)]` : ""}`;
    case "assistant":
      return `\n${i.text}`;
    case "reasoning":
      return `  (thinking) ${i.text.split("\n")[0].slice(0, 120)}`;
    case "tool": {
      const input = JSON.stringify(i.input ?? {});
      const mark = i.status === "running" ? "…" : i.status === "error" ? "✗" : "✓";
      return `  ${mark} ${i.name} ${input.length > 120 ? input.slice(0, 117) + "..." : input}`;
    }
    case "notice":
      return `  [${i.text}]`;
    case "plan":
      return i.entries.map((e) => `  ${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.text}`).join("\n");
    case "subagent": {
      const mark = i.status === "running" ? "…" : i.status === "error" ? "✗" : "✓";
      return `  ${mark} subagent ${i.title}${i.agentType ? ` (${i.agentType})` : ""}${i.activity && i.status === "running" ? ` - ${i.activity}` : ""}`;
    }
  }
}

function renderEvent(e: AgentEvent): string | null {
  switch (e.type) {
    case "item":
      return renderItem(e.item);
    case "question":
      return e.request.prompts
        .map((p) => `  ? question ${e.request.id} ${p.id}: ${p.text}${p.options ? ` [${p.options.map((o) => o.label).join(" | ")}]` : ""}`)
        .join("\n");
    case "permission":
      return `  ? permission ${e.request.id}: ${e.request.title ?? e.request.toolName} ${JSON.stringify(e.request.input)}`;
    case "turnEnded":
      return `-- turn ${e.outcome}${e.error ? `: ${e.error}` : ""}`;
    default:
      return null;
  }
}

async function main() {
  if (opt.help || !cmd) return console.log(usage);

  if (cmd === "host") {
    const [sub, name, url, token] = args;
    const h = readHosts();
    if (sub === "add" && name && url && token) {
      h.hosts[name] = { url, token };
      if (opt.default || !h.default) h.default = name;
      return writeHosts(h);
    }
    if (sub === "list")
      return out(h, () => {
        for (const [n, v] of Object.entries(h.hosts)) console.log(`${n === h.default ? "*" : " "} ${n}\t${v.url}`);
      });
    if (sub === "rm" && name) {
      delete h.hosts[name];
      if (h.default === name) delete h.default;
      return writeHosts(h);
    }
    fail(`usage: casm host add|list|rm`);
  }

  const c = await connect();
  try {
    await run(c);
  } finally {
    c.close();
  }
}

async function projects(c: CasmClient): Promise<Project[]> {
  return (await c.call("project.list", { includeArchived: true })).projects;
}

async function agentRef(c: CasmClient, ref: string | undefined): Promise<Agent> {
  if (!ref) fail("missing <agent>");
  return pick((await c.call("agent.list", { includeArchived: true })).agents, ref, "agent");
}

async function waitAndPrint(c: CasmClient, id: string) {
  const timeoutMs = opt.timeout ? Number(opt.timeout) * 1000 : undefined;
  const r = await c.call("agent.wait", { id, timeoutMs });
  // A turn that hit a usage limit ends idle with its prompt deferred.
  const { deferred } = await c.call("agent.get", { id });
  out({ ...r, deferred }, () => {
    if (r.status === "waiting") console.error(`agent is waiting for you: casm permissions ${shortId(id)} / casm questions ${shortId(id)}`);
    if (r.timedOut) console.error("timed out; the agent is still running");
    if (deferred) console.error(`usage limit: ${deferred.reason}\nqueued; retries ${new Date(deferred.until).toLocaleString()}`);
    else if (r.lastReply) console.log(r.lastReply);
  });
  // Exit codes: 3 still running or waiting for you, 4 deferred by a usage limit.
  if (r.status !== "idle") process.exitCode = 3;
  else if (deferred) process.exitCode = 4;
}

async function run(c: CasmClient) {
  switch (cmd) {
    case "info": {
      const i = await c.call("server.info", {});
      return out(i, () => console.log(`${i.name}  casm ${i.version}  protocol ${i.protocol}  id ${i.id}\nagents: ${i.providers.join(", ")}`));
    }

    case "shell": {
      const a = await agentRef(c, args[0]);
      const command = args.slice(1).join(" ");
      if (!command) fail("shell needs a command");
      c.on("agent.event", ({ agentId, event }) => {
        if (agentId !== a.id) return;
        if (event.type === "toolOutput") process.stdout.write(event.text);
      });
      await c.call("agent.subscribe", { id: a.id });
      await c.call("agent.shell", { id: a.id, command });
      const r = await c.call("agent.wait", { id: a.id });
      if (r.status !== "idle") process.exitCode = 3;
      return;
    }

    case "projects": {
      const list = await projects(c);
      return out(list, () => {
        const groups = [...new Set(list.map((p) => p.group))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
        for (const g of groups) {
          if (g) console.log(`${g}/`);
          for (const p of list.filter((x) => x.group === g)) {
            const extra = [p.path, p.tags.length ? `#${p.tags.join(" #")}` : "", p.archivedAt ? "(archived)" : ""].filter(Boolean);
            console.log(`${shortId(p.id)}  ${g ? "  " : ""}${p.name}  ${extra.join("  ")}`);
          }
        }
      });
    }

    case "project": {
      const [sub, ref, value] = args;
      if (sub === "create" && ref) {
        const p = await c.call("project.create", { path: resolve(ref), name: opt.name, group: opt.group, tags: opt.tag });
        return out(p, () => console.log(p.id));
      }
      if (sub === "group" && ref) {
        const id = pick(await projects(c), ref, "project").id;
        await c.call("project.update", { id, group: value ?? null });
        return;
      }
      if (sub === "rm" && ref) {
        await c.call("project.delete", { id: pick(await projects(c), ref, "project").id });
        return;
      }
      if (sub === "agents-md" && ref) {
        const id = pick(await projects(c), ref, "project").id;
        const md = await c.call("project.agentsMd", { id });
        if (!opt.edit) return out(md, () => (md.content === null ? console.error(`no ${md.path}`) : process.stdout.write(md.content)));
        const dir = mkdtempSync(join(tmpdir(), "casm-"));
        const file = join(dir, "AGENTS.md");
        try {
          writeFileSync(file, md.content ?? "");
          const editor = process.env.VISUAL || process.env.EDITOR || "vi";
          // Through sh, so EDITOR may carry arguments ("code --wait").
          const r = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
          if (r.status !== 0) fail(`${editor} exited with ${r.status ?? r.signal}; ${md.path} not changed`);
          const content = readFileSync(file, "utf8");
          if (content === (md.content ?? "")) return console.error("no changes");
          const saved = await c.call("project.setAgentsMd", { id, content });
          return out(saved, () => console.error(`saved ${saved.path}`));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      if (sub === "memories" && ref) {
        const res = await c.call("project.memories", { id: pick(await projects(c), ref, "project").id });
        return out(res, () => {
          if (!res.agents.length) console.log("no memories");
          for (const a of res.agents) {
            console.log(`${a.provider} (${a.scope})  ${a.location}`);
            for (const e of a.entries) console.log(`  ${e.id}${e.title ? `  ${e.title}` : ""}${e.updatedAt ? `  ${e.updatedAt.slice(0, 10)}` : ""}`);
          }
        });
      }
      fail("usage: casm project create|group|rm|agents-md|memories");
    }

    case "agents": {
      const projectId = opt.project ? pick(await projects(c), opt.project, "project").id : undefined;
      const { agents } = await c.call("agent.list", { projectId, includeArchived: opt.all });
      const names = new Map((await projects(c)).map((p) => [p.id, p.name]));
      const usage = new Map<string, Usage | null>();
      if (opt.usage) for (const a of agents) usage.set(a.id, (await c.call("agent.usage", { id: a.id })).usage);
      const rows = opt.usage ? agents.map((a) => ({ ...a, usage: usage.get(a.id) ?? null })) : agents;
      return out(rows, () => {
        for (const a of agents)
          console.log(
            `${shortId(a.id)}  ${a.status.padEnd(7)}  ${a.provider.padEnd(8)}  ${names.get(a.projectId) ?? "?"} / ${a.name}${a.archivedAt ? "  (archived)" : ""}${a.deferred ? `  limited, retries ${new Date(a.deferred.until).toLocaleTimeString()}` : ""}${a.pending?.count && !a.deferred ? `  ${a.pending.count} pending` : ""}${opt.usage ? `  ${usage.get(a.id) ? formatUsage(usage.get(a.id)!) : "-"}` : ""}`,
          );
      });
    }

    case "run": {
      const prompt = args.join(" ");
      if (!opt.project) fail("run needs --project");
      if (!prompt) fail("run needs a prompt");
      const project = pick(await projects(c), opt.project, "project");
      const a = await c.call("agent.create", {
        projectId: project.id,
        provider: (opt.provider ?? "claude") as ProviderId,
        name: opt.name,
        config: { model: opt.model, mode: opt.mode, casmTools: opt["casm-tools"] },
        parent: runParent(),
        prompt,
      });
      if (opt.wait) return waitAndPrint(c, a.id);
      return out(a, () => console.log(a.id));
    }

    case "send": {
      const a = await agentRef(c, args[0]);
      const text = args.slice(1).join(" ");
      if (!text) fail("send needs text");
      // --at is shorthand for a one-off schedule on this agent.
      if (opt.at) {
        const x = await c.call("schedule.create", {
          name: "Send later",
          cadence: { type: "once", at: parseWhen(opt.at) },
          target: { type: "agent", agentId: a.id },
          prompt: text,
        });
        return out(x, () => console.error(`scheduled for ${new Date(x.nextRunAt!).toLocaleString()} (schedule ${shortId(x.id)})`));
      }
      const r = await c.call("agent.send", {
        id: a.id,
        text,
        whenBusy: opt.steer ? "steer" : "queue",
        whenLimited: opt["fail-if-limited"] ? "fail" : "queue",
      });
      if (r.deferredUntil) {
        out(r, () => console.error(`${a.provider} is over its usage limit; queued until ${new Date(r.deferredUntil!).toLocaleString()}`));
        return;
      }
      if (opt.wait) return waitAndPrint(c, a.id);
      return out(r, () => r.queued && console.error("queued behind the running turn"));
    }

    case "wait":
      return waitAndPrint(c, (await agentRef(c, args[0])).id);

    case "history": {
      const a = await agentRef(c, args[0]);
      const h = await c.call("agent.history", { id: a.id, limit: opt.n ? Number(opt.n) : 50 });
      return out(h, () => {
        if (h.start > 0) console.log(`(${h.start} earlier items)`);
        for (const i of h.items) console.log(renderItem(i));
      });
    }

    case "watch": {
      const a = await agentRef(c, args[0]);
      c.on("agent.event", ({ agentId, event }) => {
        if (agentId !== a.id) return;
        if (opt.json) return console.log(JSON.stringify(event));
        const line = renderEvent(event);
        if (line) console.log(line);
      });
      c.on("agent.status", ({ agentId, status }) => agentId === a.id && !opt.json && console.error(`[${status}]`));
      const s = await c.call("agent.subscribe", { id: a.id });
      if (!opt.json) console.error(`[${s.status}] watching ${a.name}; Ctrl-C to stop`);
      for (const e of s.turn) {
        const line = opt.json ? JSON.stringify(e) : renderEvent(e);
        if (line) console.log(line);
      }
      await new Promise(() => {});
      return;
    }

    case "permissions": {
      const a = await agentRef(c, args[0]);
      const { permissions } = await c.call("agent.subscribe", { id: a.id });
      await c.call("agent.unsubscribe", { id: a.id });
      return out(permissions, () => {
        for (const p of permissions) console.log(`${p.id}  ${p.title ?? p.toolName}  ${JSON.stringify(p.input)}`);
      });
    }

    case "questions": {
      const a = await agentRef(c, args[0]);
      const { questions } = await c.call("agent.subscribe", { id: a.id });
      await c.call("agent.unsubscribe", { id: a.id });
      return out(questions, () => {
        for (const q of questions) {
          console.log(`${q.id}${q.title ? `  ${q.title}` : ""}`);
          for (const p of q.prompts) {
            const opts = p.options?.map((o) => o.label).join(" | ");
            console.log(`  ${p.id} (${p.kind}${p.multiple ? ", several" : ""}): ${p.text}${opts ? `  [${opts}]` : ""}`);
          }
        }
      });
    }

    case "answer": {
      const a = await agentRef(c, args[0]);
      const requestId = args[1];
      if (!requestId) fail("answer needs a request id (see casm questions)");
      if (opt.dismiss) return void (await c.call("agent.answerQuestion", { id: a.id, requestId }));
      const { questions } = await c.call("agent.subscribe", { id: a.id });
      await c.call("agent.unsubscribe", { id: a.id });
      const q = questions.find((x) => x.id === requestId) ?? fail(`no pending question ${requestId}`);
      const answers: Record<string, string | string[] | boolean> = {};
      for (const pair of args.slice(2)) {
        const i = pair.indexOf("=");
        if (i < 1) fail(`expected <prompt>=<value>, got "${pair}"`);
        const key = pair.slice(0, i);
        const value = pair.slice(i + 1);
        const prompt = q.prompts.find((p) => p.id === key) ?? fail(`no prompt "${key}" in ${requestId}`);
        if (prompt.kind === "confirm") answers[key] = /^(y|yes|true|1)$/i.test(value);
        else if (prompt.multiple) answers[key] = [...((answers[key] as string[] | undefined) ?? []), value];
        else answers[key] = value;
      }
      await c.call("agent.answerQuestion", { id: a.id, requestId, answers });
      return;
    }

    case "limits": {
      const { limits } = await c.call("provider.limits", { provider: opt.provider as ProviderId | undefined, refresh: opt.refresh });
      return out(limits, () => {
        if (!limits.length) console.log("no limits reported yet (they appear once an agent has run, or with --refresh for agents that can be queried)");
        for (const l of limits) {
          console.log(`${l.provider}${l.plan ? `  (${l.plan})` : ""}  as of ${l.updatedAt}`);
          for (const w of l.windows) {
            const used = w.usedPercent === undefined ? "?" : `${Math.round(w.usedPercent)}%`;
            const reset = w.resetsAt ? `  resets ${w.resetsAt}` : "";
            console.log(`  ${(w.label ?? w.id).padEnd(16)} ${used.padStart(4)} used${w.status && w.status !== "ok" ? `  ${w.status}` : ""}${reset}`);
          }
        }
      });
    }

    case "schedules": {
      const agentId = opt.agent ? (await agentRef(c, opt.agent)).id : undefined;
      const { schedules } = await c.call("schedule.list", { agentId });
      const names = new Map((await c.call("agent.list", { includeArchived: true })).agents.map((x) => [x.id, x.name]));
      return out(schedules, () => {
        if (!schedules.length) console.log("no schedules");
        for (const x of schedules) {
          const cad = x.cadence.type === "cron" ? `cron ${x.cadence.expr}` : x.cadence.type === "every" ? `every ${x.cadence.minutes}m` : `once ${new Date(x.cadence.at).toLocaleString()}`;
          const tgt = x.target.type === "agent" ? `→ ${names.get(x.target.agentId) ?? shortId(x.target.agentId)}` : `new ${x.target.provider} agent`;
          const next = x.enabled && x.nextRunAt ? `next ${new Date(x.nextRunAt).toLocaleString()}` : "disabled";
          const last = x.lastRun ? `  last ${x.lastRun.outcome}${x.lastRun.error ? `: ${x.lastRun.error}` : ""}` : "";
          console.log(`${shortId(x.id)}  ${x.name}  ${cad}  ${tgt}  ${next}${last}`);
        }
      });
    }

    case "schedule": {
      const [sub2, ref] = args;
      const pickSchedule = async (r?: string) => {
        if (!r) fail("missing <schedule>");
        const { schedules } = await c.call("schedule.list", {});
        return pick(schedules, r, "schedule");
      };
      if (sub2 === "add") {
        const prompt = args.slice(1).join(" ");
        if (!prompt) fail("schedule add needs a prompt");
        const cadence = opt.cron
          ? { type: "cron" as const, expr: opt.cron }
          : opt.every
            ? { type: "every" as const, minutes: Math.max(1, Math.round((Date.parse(parseWhen(opt.every)) - Date.now()) / 60_000)) }
            : opt.at
              ? { type: "once" as const, at: parseWhen(opt.at) }
              : fail("schedule add needs --cron, --every or --at");
        const target = opt.agent
          ? { type: "agent" as const, agentId: (await agentRef(c, opt.agent)).id, whenBusy: opt["skip-if-busy"] ? ("skip" as const) : ("queue" as const) }
          : opt.project
            ? {
                type: "newAgent" as const,
                projectId: pick(await projects(c), opt.project, "project").id,
                provider: (opt.provider ?? "claude") as ProviderId,
                config: { model: opt.model, mode: opt.mode },
                name: opt.name,
              }
            : fail("schedule add needs --agent, or --project and --provider");
        const x = await c.call("schedule.create", { name: opt.name, cadence, target, prompt });
        return out(x, () => console.log(`${x.id}  next ${x.nextRunAt ? new Date(x.nextRunAt).toLocaleString() : "-"}`));
      }
      const x = await pickSchedule(ref);
      if (sub2 === "rm") return void (await c.call("schedule.delete", { id: x.id }));
      if (sub2 === "enable" || sub2 === "disable") return void (await c.call("schedule.update", { id: x.id, enabled: sub2 === "enable" }));
      if (sub2 === "run") {
        const r = await c.call("schedule.runNow", { id: x.id });
        return out(r, () => console.log(`${r.outcome}${r.agentId ? `  agent ${shortId(r.agentId)}` : ""}${r.error ? `: ${r.error}` : ""}`));
      }
      fail("usage: casm schedule add|run|enable|disable|rm");
    }

    case "pending": {
      const a = args[0] ? await agentRef(c, args[0]) : null;
      const all = await c.call("pending.list", {});
      const messages = a ? all.messages.filter((m) => m.agentId === a.id) : all.messages;
      const blocked = a ? all.blocked.filter((b) => b.agentId === a.id) : all.blocked;
      const names = new Map((await c.call("agent.list", { includeArchived: true })).agents.map((x) => [x.id, x.name]));
      return out({ messages, blocked }, () => {
        if (!messages.length && !blocked.length) console.log("nothing pending");
        for (const b of blocked) {
          const what = [b.permissions && `${b.permissions} permission prompt(s)`, b.questions && `${b.questions} question(s)`].filter(Boolean).join(", ");
          console.log(`${shortId(b.agentId)}  ${names.get(b.agentId) ?? ""}  waiting for you: ${what}`);
        }
        for (const m of messages) {
          const when = m.notBefore ? `  at ${new Date(m.notBefore).toLocaleString()}` : "";
          const text = m.text.replace(/\s+/g, " ");
          console.log(
            `${shortId(m.id)}  ${shortId(m.agentId)}  ${(names.get(m.agentId) ?? "").slice(0, 24).padEnd(24)}  ${m.reason.padEnd(9)}${when}  ${text.length > 60 ? text.slice(0, 57) + "..." : text}${m.imageCount ? ` [${m.imageCount} image(s)]` : ""}`,
          );
          if (m.note) console.log(`          ${m.note.slice(0, 120)}`);
        }
      });
    }

    case "cancel": {
      const a = await agentRef(c, args[0]);
      let messageId: string | undefined;
      if (args[1]) {
        const { messages } = await c.call("agent.pending", { id: a.id });
        messageId = pick(messages.map((m) => ({ ...m, name: m.id })), args[1], "pending message").id;
      } else if (!opt.all) fail("cancel needs a message id, or --all");
      const r = await c.call("agent.cancelPending", { id: a.id, messageId });
      return out(r, () => console.error(`cancelled ${r.cancelled}`));
    }

    case "usage": {
      const a = await agentRef(c, args[0]);
      const { usage } = await c.call("agent.usage", { id: a.id });
      return out(usage, () => console.log(usage ? formatUsage(usage) : "no usage reported yet"));
    }

    case "models": {
      const { providers } = await c.call("server.info", {});
      const wanted = opt.provider ? [opt.provider as ProviderId] : providers;
      const result: Record<string, unknown> = {};
      for (const p of wanted) {
        try {
          result[p] = await c.call("provider.catalog", { provider: p, refresh: opt.refresh });
        } catch (e) {
          result[p] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return out(result, () => {
        for (const [p, cat] of Object.entries(result) as [string, { error?: string; models?: { id: string; name?: string; isDefault?: boolean; efforts?: string[] }[]; modes?: { id: string }[] }][]) {
          console.log(`${p}${cat.error ? `  (error: ${cat.error})` : ""}`);
          for (const m of cat.models ?? [])
            console.log(`  ${m.isDefault ? "*" : " "} ${m.id}${m.name && m.name !== m.id ? `  ${m.name}` : ""}${m.efforts?.length ? `  effort: ${m.efforts.join(", ")}` : ""}`);
          if (cat.modes?.length) console.log(`    modes: ${cat.modes.map((m) => m.id).join(", ")}`);
        }
      });
    }

    case "approve":
    case "deny": {
      const a = await agentRef(c, args[0]);
      if (!args[1]) fail(`${cmd} needs a request id (see casm permissions)`);
      await c.call("agent.respondPermission", {
        id: a.id,
        requestId: args[1],
        decision: cmd === "deny" ? "deny" : opt.always ? "allowAlways" : "allow",
        message: opt.message,
      });
      return;
    }

    case "interrupt":
    case "reload":
    case "restart": {
      const a = await agentRef(c, args[0]);
      await c.call(`agent.${cmd}`, { id: a.id });
      return;
    }

    case "archive": {
      const a = await agentRef(c, args[0]);
      await c.call("agent.update", { id: a.id, archived: true });
      return;
    }

    case "rm": {
      const a = await agentRef(c, args[0]);
      await c.call("agent.delete", { id: a.id });
      return;
    }

    default:
      fail(`unknown command "${cmd}"\n\n${usage}`);
  }
}

// Server subcommands load the server code only when needed.
if (serverSubcommand) {
  const { serverCommand } = await import("@casm/server/command");
  await serverCommand(process.argv.slice(2));
} else {
  await main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

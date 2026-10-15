#!/usr/bin/env node
// casm — the casm server (`casm serve`, `casm token`) and its command-line client.
// Client commands take -H/--host and --json. On a machine running a server the
// client talks to it, and -H names one of its peers (the server forwards);
// elsewhere -H picks an entry of hosts.json.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { CasmClient } from "@casm/client";
import type { Agent, AgentEvent, Item, Project, ProviderId, Usage } from "@casm/protocol";

const home = process.env.CASM_HOME ?? join(homedir(), ".casm-ng");
const hostsFile = join(home, "hosts.json");
// Written by `casm serve` on this machine.
const localFile = join(home, "local.json");

type Hosts = { default?: string; hosts: Record<string, { url: string; token: string }> };

function readHosts(): Hosts {
  try {
    return JSON.parse(readFileSync(hostsFile, "utf8"));
  } catch {
    return { hosts: {} };
  }
}

// The server this CLI talks to directly: $CASM_URL + $CASM_TOKEN, else the one
// running on this machine. Undefined on a machine without a server.
function localServer(): { url: string; token: string; source: string } | undefined {
  if (process.env.CASM_URL && process.env.CASM_TOKEN) return { url: process.env.CASM_URL, token: process.env.CASM_TOKEN, source: "CASM_URL" };
  try {
    const { url, token } = JSON.parse(readFileSync(localFile, "utf8"));
    if (typeof url === "string" && typeof token === "string") return { url, token, source: localFile };
  } catch {}
  return undefined;
}

function writeHosts(h: Hosts) {
  mkdirSync(home, { recursive: true });
  writeFileSync(hostsFile, JSON.stringify(h, null, 2) + "\n", { mode: 0o600 });
}

const usage = `usage: casm [-H host] [--json] <command>

-H host: on a machine running a casm server, commands go to that server, and
-H <peer> makes it forward them to its peer of that name (see "peer add").
Without a server here, -H picks a host from ${hostsFile}.

server (this machine only; refused with -H):
  serve [--listen host:port] [--name n]
  token create <name> | token list | token revoke <name>
  peer add <name> <ws-url> <token> | peer list [--probe] | peer rm <name>

  peers [--probe]                    the server's peers: the hosts -H can name
  agent-prompt [agent]               the host prompt every agent gets ahead of its own system prompt,
                                     filled in for <agent> or an example one
  agent-prompt --edit | --reset      edit the host's agent-prompt.md in $EDITOR (seeded with the
                                     default) | delete it, back to the default
  agent-prompt --enable | --disable  turn it on or off ("agentPrompt" in the host's config.json)

hosts (only for a CLI on a machine without a server):
  host add <name> <ws-url> <token> [--default]
  host list | host rm <name>

projects:
  projects
  project create <dir> [--name n] [--group g] [--tag t]...
  project group <project> [group]     set the project's group; omit it to ungroup
  project rm <project>
  project agents-md <project> [--edit]  print <project>/AGENTS.md; --edit opens $EDITOR and saves
  project memories <project>          each agent's memories for the project folder (--json: full text)

files (read-only, inside project folders on the host):
  cat <path> [--force]               print a text file; --force prints a binary one too
  get <path> [-o out]                download a file (default: its name, here); -o - writes to stdout

agents:
  agents [--project p] [--all] [--usage]
  run --project p [--cwd dir] [--provider claude] [--name n] [--model m] [--mode m]
      [--parent serverId/agentId] [--casm-tools] [--env K=V]... [--wait] <prompt>
                                     --cwd: a folder inside the project (relative to it, or absolute),
                                     e.g. a worktree: --cwd .worktrees/<task>
                                     --env: the agent's environment, e.g. a provider's base URL
  send <agent> <text> [--steer] [--wait] [--fail-if-limited] [--message-id UUID]
                                     queued while the agent is busy; --steer puts it into the running turn
                                     reuse --message-id after an uncertain response to avoid duplicates
  pending [agent]                    messages waiting for their agent (busy or over a limit),
                                     and agents waiting for a permission or answer
  subagents [agent] [-n count]       subagents the agents run themselves (Claude Task/Agent,
                                     Codex sub-agents, OpenCode tasks): running, then recent

schedules (run on the host; messages to busy or limited agents become pending):
  schedules [--agent a]
  schedule add (--cron "0 9 * * 1-5" | --every 30m | --at 18:30|"in 2h"|ISO) <prompt>
               (--agent a [--skip-if-busy] | --project p --provider claude [--model m] [--mode m] [--env K=V]... [--name n])
  schedule edit <schedule> [--name n] [--cron e | --every d | --at t] [new prompt]
  schedule run | enable | disable | rm <schedule>
  cancel <agent> [message-id|--all]  cancel pending messages
  retry <agent> <message-id>         retry now a message held back by a failure or a limit
                                     (see casm pending); while busy, it goes after the turn
  send-now <agent> <message-id> [--wait]   send a pending message now, images included:
                                     into the running turn, or as a new turn if idle
  wait <agent> [--timeout seconds]   exit 3: still busy, 4: deferred by a limit, 5: the turn failed
  history <agent> [-n count] [--subagent id]   --subagent: that subagent's own transcript
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
  shell <agent> <command>            run a command in the agent's directory (like "!cmd"); exit 1 if it fails
  mcp <agent> [--reconnect [server]]   MCP status, or reconnect one/all servers
  interrupt <agent>                 stop the turn; keep the queue and continue with its next message
  reload | restart | archive | rm <agent>

<project> and <agent> accept an id, an id prefix or an exact name.
Environment: CASM_HOST is the default for -H; CASM_URL + CASM_TOKEN name the
server to talk to instead of this machine's (${localFile}).
Inside a casm agent, CASM_SERVER_ID, CASM_SERVER_NAME and CASM_AGENT_ID are set,
so "casm run" links the new agent to it as parent (override with --parent, or --parent none).`;

const options = {
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
  reconnect: { type: "boolean" },
  usage: { type: "boolean" },
  "fail-if-limited": { type: "boolean" },
  "message-id": { type: "string" },
  at: { type: "string" },
  cron: { type: "string" },
  every: { type: "string" },
  agent: { type: "string" },
  "skip-if-busy": { type: "boolean" },
  "casm-tools": { type: "boolean" },
  env: { type: "string", multiple: true },
  edit: { type: "boolean" },
  probe: { type: "boolean" },
  subagent: { type: "string" },
  cwd: { type: "string" },
  reset: { type: "boolean" },
  enable: { type: "boolean" },
  disable: { type: "boolean" },
  force: { type: "boolean" },
  output: { type: "string", short: "o" },
} as const;

// The first positional decides; flags (and the values of flags that take one) may
// come before it, e.g. "casm --json peer list" or "casm -p serve run x".
const takesValue = (a: string) => {
  if (a.startsWith("--")) return !a.includes("=") && (a === "--listen" || options[a.slice(2) as keyof typeof options]?.type === "string");
  return a.length === 2 && Object.values(options).some((o) => "short" in o && o.short === a[1] && o.type === "string");
};
const firstCommand = process.argv.slice(2).find((a, i, all) => !a.startsWith("-") && !(i > 0 && takesValue(all[i - 1])));
const serverSubcommand = ["serve", "token", "peer"].includes(firstCommand ?? "");

const { values: opt, positionals } = parseArgs({
  args: serverSubcommand ? [] : process.argv.slice(2),
  allowPositionals: true,
  options,
});

const [cmd, ...args] = positionals;

function fail(msg: string): never {
  console.error(`casm: ${msg}`);
  process.exit(1);
}

// --env K=V (repeatable) as the agent's config.env; undefined when not given.
function envOption(): Record<string, string> | undefined {
  if (!opt.env?.length) return undefined;
  return Object.fromEntries(opt.env.map((kv) => {
    const i = kv.indexOf("=");
    if (i < 1) fail(`--env needs NAME=value, got ${JSON.stringify(kv)}`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

function out(json: unknown, human: () => void) {
  if (opt.json) console.log(JSON.stringify(json, null, 2));
  else human();
}

// The server the client connected to; downloads come from its HTTP side.
let serverUrl = "";

async function connect(): Promise<CasmClient> {
  const local = localServer();
  const peer = opt.host ?? process.env.CASM_HOST;
  serverUrl = local?.url ?? "";
  if (local)
    return CasmClient.connect(local.url, local.token, { host: peer }).catch((e: Error) =>
      fail(`${e.message}\n(the casm server from ${local.source}; is it running? "casm service status")`),
    );
  const h = readHosts();
  const name = peer ?? h.default ?? Object.keys(h.hosts)[0];
  if (!name) fail(`no hosts configured; run "casm host add <name> <ws-url> <token>"`);
  const host = h.hosts[name];
  if (!host) fail(`unknown host "${name}" (known: ${Object.keys(h.hosts).join(", ") || "none"})`);
  serverUrl = host.url;
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

// A peer probe (peer.list probe): "reachable 120 ms", "slow: 4.2 s ...", "unreachable: ...".
function probeText(s: { reachable?: boolean; latencyMs?: number; slow?: boolean; error?: string }): string {
  if (!s.reachable) return `unreachable: ${s.error}`;
  const ms = s.latencyMs === undefined ? "" : s.latencyMs >= 1000 ? ` ${(s.latencyMs / 1000).toFixed(1)} s` : ` ${s.latencyMs} ms`;
  return s.slow ? `slow:${ms} (reachable, but loaded)` : `reachable${ms}`;
}

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

// Agent sessions supply their origin explicitly; ordinary shells send no sender.
function messageSender() {
  const { CASM_SERVER_ID: serverId, CASM_AGENT_ID: agentId, CASM_AGENT_NAME: name, CASM_SERVER_NAME: host } = process.env;
  return serverId && agentId ? { serverId, agentId, ...(name ? { name } : {}), ...(host ? { host } : {}) } : undefined;
}

function renderItem(i: Item): string {
  switch (i.kind) {
    case "user":
      return `\n${i.sender ? `from ${i.sender.schedule ? `schedule ${i.sender.schedule.name}` : (i.sender.name ?? i.sender.agentId)}${i.sender.host ? ` · ${i.sender.host}` : ""}\n` : ""}> ${i.text.replaceAll("\n", "\n> ")}${i.images?.length ? `\n> [${i.images.length} image(s)]` : ""}`;
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
    if (sub === "add" && localServer())
      fail(`this machine runs a casm server (${localServer()!.source}), so -H names its peers; add the host with "casm peer add ${name ?? "<name>"} <ws-url> <token>"`);
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
  // Streaming commands end when the server, or the peer it forwards to, goes away.
  c.on("peer.disconnected", ({ host }) => fail(`lost the connection to host "${host}"`));
  const offClose = c.onClose(() => fail("lost the connection to the casm server"));
  try {
    await run(c);
  } finally {
    offClose();
    c.close();
  }
}

// The whole file, over a signed download link (a peer's streams through the server).
async function download(c: CasmClient, path: string) {
  const link = await c.call("fs.downloadLink", { path });
  const url = new URL(link.url, serverUrl.replace(/^ws/, "http"));
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status} ${(await res.text()).trim()}`);
  return { link, body: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream) };
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
  const failed = r.status === "idle" && r.lastTurn?.outcome === "failed";
  // A turn that failed before the agent answered keeps its prompt as a pending message.
  const kept = failed ? r.lastTurn?.kept?.[0] : undefined;
  out({ ...r, deferred }, () => {
    if (r.status === "waiting") console.error(`agent is waiting for you: casm permissions ${shortId(id)} / casm questions ${shortId(id)}`);
    if (r.timedOut) console.error("timed out; the agent is still running");
    if (deferred) console.error(`usage limit: ${deferred.reason}\nqueued; retries ${new Date(deferred.until).toLocaleString()}`);
    else if (failed) console.error(`the turn failed: ${r.lastTurn!.error ?? "no reason given"}${kept ? `\nthe message is kept: casm retry ${shortId(id)} ${shortId(kept)} (or casm cancel)` : ""}`);
    else if (r.lastReply) console.log(r.lastReply);
    if (r.status === "idle" && r.lastTurn?.outcome === "interrupted") console.error("the turn was interrupted");
  });
  // Exit codes: 3 still running or waiting for you, 4 deferred by a usage limit, 5 the turn failed.
  if (r.status !== "idle") process.exitCode = 3;
  else if (deferred) process.exitCode = 4;
  else if (failed) process.exitCode = 5;
}

async function run(c: CasmClient) {
  switch (cmd) {
    case "info": {
      const i = await c.call("server.info", {});
      return out(i, () => console.log(`${i.name}  casm ${i.version}  protocol ${i.protocol}  id ${i.id}\nagents: ${i.providers.join(", ")}`));
    }

    case "peers": {
      const { peers } = await c.call("peer.list", { probe: opt.probe });
      return out(peers, () => {
        if (!peers.length) console.log('no peers (add one on the server machine: casm peer add <name> <ws-url> <token>)');
        for (const p of peers)
          console.log(`${p.name}\t${p.url}${p.reachable === undefined ? "" : `  ${probeText(p)}`}`);
      });
    }

    case "agent-prompt": {
      if (opt.enable || opt.disable) {
        const r = await c.call("server.setAgentPrompt", { enabled: !!opt.enable });
        return out(r, () => console.error(`agent prompt ${r.enabled ? "enabled" : "disabled"}`));
      }
      if (opt.reset) {
        const r = await c.call("server.setAgentPrompt", { content: null });
        return out(r, () => console.error(`removed ${r.path}; agents get the default prompt`));
      }
      const agentId = args[0] ? (await agentRef(c, args[0])).id : undefined;
      const info = await c.call("server.agentPrompt", { agentId });
      if (!opt.edit)
        return out(info, () => {
          if (!info.enabled) console.error(`the agent prompt is disabled (casm agent-prompt --enable)`);
          else {
            console.error(`${info.custom ? info.path : "built-in default"}, filled in for ${agentId ? "this agent" : "an example agent with casm tools"}:\n`);
            console.log(info.rendered);
          }
        });
      const dir = mkdtempSync(join(tmpdir(), "casm-"));
      const file = join(dir, "agent-prompt.md");
      try {
        writeFileSync(file, info.content.endsWith("\n") ? info.content : info.content + "\n");
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const r = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
        if (r.status !== 0) fail(`${editor} exited with ${r.status ?? r.signal}; ${info.path} not changed`);
        const content = readFileSync(file, "utf8");
        if (content.trim() === info.content.trim()) return console.error("no changes");
        if (!content.trim()) fail(`empty prompt not saved (casm agent-prompt --reset goes back to the default, --disable turns it off)`);
        const saved = await c.call("server.setAgentPrompt", { content });
        return out(saved, () => console.error(`saved ${saved.path}; applies to sessions opened from now on`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    case "shell": {
      const a = await agentRef(c, args[0]);
      const command = args.slice(1).join(" ");
      if (!command) fail("shell needs a command");
      let failed = false;
      c.on("agent.event", ({ agentId, event }) => {
        if (agentId !== a.id) return;
        if (event.type === "toolOutput") process.stdout.write(event.text);
        if (event.type === "item" && event.item.kind === "tool" && event.item.origin === "user") failed = event.item.status === "error";
      });
      await c.call("agent.subscribe", { id: a.id });
      await c.call("agent.shell", { id: a.id, command });
      const r = await c.call("agent.wait", { id: a.id });
      // Exit 1 when the command failed, 3 when the agent is still busy.
      if (r.status !== "idle") process.exitCode = 3;
      else if (failed || r.lastTurn?.outcome === "failed") process.exitCode = 1;
      return;
    }

    case "cat": {
      const path = args[0] ?? fail("usage: casm cat <path> [--force]");
      const file = await c.call("fs.read", { path });
      if (file.type === "dir") fail(`${path} is a directory`);
      if (file.binary && !opt.force) fail(`${path} is a binary file (${file.mime}, ${file.size} bytes); "casm get" downloads it, --force prints it`);
      if (file.content !== null && !file.truncated) return void process.stdout.write(file.content);
      return pipeline((await download(c, path)).body, process.stdout);
    }

    case "get": {
      const path = args[0] ?? fail("usage: casm get <path> [-o out]");
      const { link, body } = await download(c, path);
      if (opt.output === "-") return pipeline(body, process.stdout);
      const target = resolve(opt.output ?? link.name);
      if (existsSync(target) && !opt.force) fail(`${target} exists; choose another -o or add --force`);
      // Written beside the target, then moved into place: no half files.
      const temp = `${target}.casm-${process.pid}.part`;
      try {
        await pipeline(body, createWriteStream(temp, { flags: "wx" }));
        renameSync(temp, target);
      } finally {
        rmSync(temp, { force: true });
      }
      return out({ path: target, size: link.size }, () => console.error(`saved ${target} (${link.size} bytes)`));
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
            `${shortId(a.id)}  ${a.status.padEnd(7)}  ${a.provider.padEnd(8)}  ${names.get(a.projectId) ?? "?"} / ${a.name}${a.archivedAt ? "  (archived)" : ""}${a.deferred ? `  limited, retries ${new Date(a.deferred.until).toLocaleTimeString()}` : ""}${a.pending?.count && !a.deferred ? `  ${a.pending.count} pending` : ""}${a.subagents?.running ? `  ${a.subagents.running} subagent${a.subagents.running === 1 ? "" : "s"}` : ""}${opt.usage ? `  ${usage.get(a.id) ? formatUsage(usage.get(a.id)!) : "-"}` : ""}`,
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
        // Relative to the project, which may be on another host: the server resolves it.
        cwd: opt.cwd,
        provider: (opt.provider ?? "claude") as ProviderId,
        name: opt.name,
        config: { model: opt.model, mode: opt.mode, casmTools: opt["casm-tools"], env: envOption() },
        parent: runParent(),
        sender: messageSender(),
        prompt,
      });
      if (opt.wait) return waitAndPrint(c, a.id);
      return out(a, () => console.log(a.id));
    }

    case "send": {
      // Messages go now; anything later is a schedule.
      if (opt.at) fail(`send has no --at; for later, schedule it: casm schedule add --at ${JSON.stringify(opt.at)} --agent ${args[0] ?? "<agent>"} "<text>"`);
      const a = await agentRef(c, args[0]);
      const text = args.slice(1).join(" ");
      if (!text) fail("send needs text");
      const r = await c.call("agent.send", {
        id: a.id,
        messageId: opt["message-id"] ?? randomUUID(),
        text,
        sender: messageSender(),
        whenBusy: opt.steer ? "steer" : "queue",
        whenLimited: opt["fail-if-limited"] ? "fail" : "queue",
      });
      if (r.deferredUntil) {
        out(r, () => console.error(`${a.provider} is over its usage limit; queued until ${new Date(r.deferredUntil!).toLocaleString()}`));
        // Same exit code as run --wait: deferred by a usage limit.
        if (opt.wait) process.exitCode = 4;
        return;
      }
      if (opt.wait) return waitAndPrint(c, a.id);
      return out(r, () => r.queued && console.error("queued behind the running turn"));
    }

    case "subagents": {
      const a = args[0] ? await agentRef(c, args[0]) : null;
      const { subagents } = await c.call("agent.subagents", { id: a?.id, limit: opt.n ? Number(opt.n) : undefined });
      const names = new Map((await c.call("agent.list", { includeArchived: true })).agents.map((x) => [x.id, x.name]));
      return out(subagents, () => {
        if (!subagents.length) console.log(a ? "no subagents" : "no subagents since the server started (give an agent to read its transcript too)");
        for (const x of subagents) {
          const status = x.stale ? "stale" : x.status;
          const u = x.usage;
          const usage = u ? [u.totalTokens !== undefined ? `${kTokens(u.totalTokens)} tok` : "", u.toolUses !== undefined ? `${u.toolUses} tools` : "", u.durationMs !== undefined ? `${Math.round(u.durationMs / 1000)}s` : ""].filter(Boolean).join(" ") : "";
          const title = x.title.replace(/\s+/g, " ");
          console.log(
            `${shortId(x.agentId)}  ${(names.get(x.agentId) ?? "").slice(0, 20).padEnd(20)}  ${status.padEnd(7)}  ${title.length > 50 ? title.slice(0, 47) + "..." : title}${x.agentType ? ` (${x.agentType})` : ""}${usage ? `  ${usage}` : ""}`,
          );
          const detail = x.status === "running" && !x.stale ? x.activity : x.summary?.replace(/\s+/g, " ");
          if (detail) console.log(`          ${detail.length > 110 ? detail.slice(0, 107) + "..." : detail}`);
          console.log(`          casm history ${shortId(x.agentId)} --subagent ${x.id}`);
        }
      });
    }

    case "wait":
      return waitAndPrint(c, (await agentRef(c, args[0])).id);

    case "history": {
      const a = await agentRef(c, args[0]);
      if (opt.subagent) {
        const { items } = await c.call("agent.subagentHistory", { id: a.id, subagentId: opt.subagent, limit: opt.n ? Number(opt.n) : 50 });
        return out(items, () => {
          if (!items.length) console.log("no transcript for that subagent (see casm subagents)");
          for (const i of items) console.log(renderItem(i));
        });
      }
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
          // The default name is the target; don't print it twice.
          console.log(`${shortId(x.id)}  ${x.name === tgt ? "" : `${x.name}  `}${cad}  ${tgt}  ${next}${last}`);
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
                config: { model: opt.model, mode: opt.mode, env: envOption() },
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
      if (sub2 === "edit") {
        const prompt = args.slice(2).join(" ");
        const cadence = opt.cron
          ? { type: "cron" as const, expr: opt.cron }
          : opt.every
            ? { type: "every" as const, minutes: Math.max(1, Math.round((Date.parse(parseWhen(opt.every)) - Date.now()) / 60_000)) }
            : opt.at
              ? { type: "once" as const, at: parseWhen(opt.at) }
              : undefined;
        if (!prompt && !cadence && !opt.name) fail("schedule edit needs a new prompt, --name, --cron, --every or --at");
        const e = await c.call("schedule.update", { id: x.id, name: opt.name, cadence, prompt: prompt || undefined });
        return out(e, () => console.log(`${shortId(e.id)}  next ${e.nextRunAt ? new Date(e.nextRunAt).toLocaleString() : "-"}`));
      }
      fail("usage: casm schedule add|edit|run|enable|disable|rm");
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

    case "retry": {
      const a = await agentRef(c, args[0]);
      if (!args[1]) fail("retry needs a message id (see casm pending)");
      const { messages } = await c.call("agent.pending", { id: a.id });
      const m = pick(messages.map((x) => ({ ...x, name: x.id })), args[1], "pending message");
      const r = await c.call("agent.retryPending", { id: a.id, messageId: m.id });
      if (opt.wait && !r.queued) return waitAndPrint(c, a.id);
      return out(r, () => r.queued && console.error(r.deferredUntil ? `queued until ${new Date(r.deferredUntil).toLocaleString()}` : "queued behind the running turn"));
    }

    case "send-now": {
      const a = await agentRef(c, args[0]);
      if (!args[1]) fail(`${cmd} needs a message id (see casm pending)`);
      const { messages } = await c.call("agent.pending", { id: a.id });
      const m = pick(messages.map((x) => ({ ...x, name: x.id })), args[1], "pending message");
      const r = await c.call("agent.steerPending", { id: a.id, messageId: m.id });
      if (opt.wait && !r.queued) return waitAndPrint(c, a.id);
      return out(r, () => r.queued && console.error(r.deferredUntil ? `${a.provider} is over its usage limit; queued until ${new Date(r.deferredUntil).toLocaleString()}` : "queued"));
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

    case "mcp": {
      const a = await agentRef(c, args[0]);
      if (args.length > (opt.reconnect ? 2 : 1)) fail("usage: casm mcp <agent> [--reconnect [server]]");
      if (opt.reconnect) {
        const result = await c.call("agent.mcpReconnect", { id: a.id, ...(args[1] ? { server: args[1] } : {}) });
        console.log(opt.json ? JSON.stringify(result) : result.message);
      } else {
        const result = await c.call("agent.mcpStatus", { id: a.id });
        if (opt.json) console.log(JSON.stringify(result));
        else {
          if (result.message) console.log(result.message);
          for (const s of result.servers) console.log(`${s.name}  ${s.status}  ${s.toolsKnown === false ? "tool count unavailable" : `${s.tools} tools`}${s.error ? `  ${s.error}` : ""}`);
          if (!result.servers.length && !result.message) console.log("No MCP servers configured.");
        }
      }
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
  // These read this machine's database directly; with a host they would show
  // local data as if it were the host's.
  const args = process.argv.slice(2);
  // "casm serve" shows no data, so an exported CASM_HOST doesn't stop it; an explicit -H still does.
  const explicitHost =
    args.find((a, i) => args[i - 1] === "-H" || args[i - 1] === "--host") ??
    args.find((a) => a.startsWith("--host="))?.slice(7) ??
    args.find((a) => a.startsWith("-H") && a.length > 2)?.slice(2);
  const host = explicitHost ?? (firstCommand === "serve" ? undefined : process.env.CASM_HOST);
  if (host)
    fail(
      `"casm ${firstCommand}" works on this machine's server only, not on host "${host}"${explicitHost === undefined ? " (from CASM_HOST)" : ""}` +
        (firstCommand === "peer" ? `; for its peers use "casm -H ${host} peers"` : firstCommand === "token" ? `; run "casm token ..." on ${host} itself` : ""),
    );
  const { serverCommand } = await import("@casm/server/command");
  await serverCommand(process.argv.slice(2));
} else {
  await main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}

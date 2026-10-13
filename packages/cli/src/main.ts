#!/usr/bin/env node
// casm — the casm server (`casm serve`, `casm token`) and its command-line client.
// Client commands take -H/--host and --json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CasmClient } from "@casm/client";
import type { Agent, AgentEvent, Item, Project, ProviderId } from "@casm/protocol";

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
  serve [--listen host:port]
  token create <name> | token list | token revoke <name>

hosts (stored in ${hostsFile}):
  host add <name> <ws-url> <token> [--default]
  host list | host rm <name>

projects:
  projects
  project create <name> [--path dir] [--parent project] [--tag t]...
  project rm <project>

agents:
  agents [--project p] [--all]
  run --project p [--provider claude] [--name n] [--cwd dir] [--model m] [--mode m] [--wait] <prompt>
  send <agent> <text> [--steer] [--wait]
  wait <agent> [--timeout seconds]
  history <agent> [-n count]
  watch <agent>                      stream live events
  permissions <agent>                list pending permission requests
  approve <agent> <request> [--always]
  deny <agent> <request> [--message text]
  interrupt | reload | restart | archive | rm <agent>

<project> and <agent> accept an id, an id prefix or an exact name.
Environment: CASM_HOST, CASM_URL + CASM_TOKEN override the host list.`;

const serverSubcommand = process.argv[2] === "serve" || process.argv[2] === "token";

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
    cwd: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    wait: { type: "boolean", short: "w" },
    steer: { type: "boolean" },
    timeout: { type: "string" },
    n: { type: "string", short: "n" },
    always: { type: "boolean" },
    message: { type: "string" },
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

function renderItem(i: Item): string {
  switch (i.kind) {
    case "user":
      return `\n> ${i.text.replaceAll("\n", "\n> ")}`;
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
  }
}

function renderEvent(e: AgentEvent): string | null {
  switch (e.type) {
    case "item":
      return renderItem(e.item);
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
  out(r, () => {
    if (r.status === "waiting") console.error(`agent is waiting for permission (casm permissions ${shortId(id)})`);
    if (r.timedOut) console.error("timed out; the agent is still running");
    if (r.lastReply) console.log(r.lastReply);
  });
  if (r.status !== "idle") process.exitCode = 3;
}

async function run(c: CasmClient) {
  switch (cmd) {
    case "info":
      return out(await c.call("server.info", {}), () => {});

    case "projects": {
      const list = await projects(c);
      const byParent = new Map<string | null, Project[]>();
      for (const p of list) byParent.set(p.parentId, [...(byParent.get(p.parentId) ?? []), p]);
      return out(list, () => {
        const walk = (parent: string | null, depth: number) => {
          for (const p of byParent.get(parent) ?? []) {
            const extra = [p.path, p.tags.length ? `#${p.tags.join(" #")}` : "", p.archivedAt ? "(archived)" : ""].filter(Boolean);
            console.log(`${shortId(p.id)}  ${"  ".repeat(depth)}${p.name}  ${extra.join("  ")}`);
            walk(p.id, depth + 1);
          }
        };
        walk(null, 0);
      });
    }

    case "project": {
      const [sub, ref] = args;
      if (sub === "create" && ref) {
        const parentId = opt.parent ? pick(await projects(c), opt.parent, "project").id : undefined;
        const p = await c.call("project.create", {
          name: ref,
          parentId,
          path: opt.path ? resolve(opt.path) : undefined,
          tags: opt.tag,
        });
        return out(p, () => console.log(p.id));
      }
      if (sub === "rm" && ref) {
        await c.call("project.delete", { id: pick(await projects(c), ref, "project").id });
        return;
      }
      fail("usage: casm project create|rm");
    }

    case "agents": {
      const projectId = opt.project ? pick(await projects(c), opt.project, "project").id : undefined;
      const { agents } = await c.call("agent.list", { projectId, includeArchived: opt.all });
      const names = new Map((await projects(c)).map((p) => [p.id, p.name]));
      return out(agents, () => {
        for (const a of agents)
          console.log(
            `${shortId(a.id)}  ${a.status.padEnd(7)}  ${a.provider.padEnd(8)}  ${names.get(a.projectId) ?? "?"} / ${a.name}${a.archivedAt ? "  (archived)" : ""}`,
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
        cwd: opt.cwd ? resolve(opt.cwd) : undefined,
        config: { model: opt.model, mode: opt.mode },
        prompt,
      });
      if (opt.wait) return waitAndPrint(c, a.id);
      return out(a, () => console.log(a.id));
    }

    case "send": {
      const a = await agentRef(c, args[0]);
      const text = args.slice(1).join(" ");
      if (!text) fail("send needs text");
      const r = await c.call("agent.send", { id: a.id, text, whenBusy: opt.steer ? "steer" : "queue" });
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

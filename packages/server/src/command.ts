// Server-side subcommands of `casm`:
//   casm serve [--listen host:port]
//   casm token create <name> | list | revoke <name>
//   casm peer add <name> <ws-url> <token> | list | rm <name>
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./db.ts";
import { startServer } from "./server.ts";
import { PeerPool, verifyPeer } from "./peers.ts";
import { execFileSync } from "node:child_process";
import { claudeProvider } from "./providers/claude.ts";
import { codexProvider } from "./providers/codex.ts";
import { opencodeProvider } from "./providers/opencode.ts";
import { piProvider } from "./providers/pi.ts";
import type { Provider } from "./providers/types.ts";

const VERSION = "0.0.1";
const DEFAULT_LISTEN = "127.0.0.1:7373";

const home = process.env.CASM_HOME ?? join(homedir(), ".casm-ng");
// How the CLI on this machine reaches this server; rewritten on every start.
const LOCAL_FILE = "local.json";
const LOCAL_TOKEN = "local-cli";

function readConfig(): { listen?: string; name?: string } {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

// Only agents installed on this host are offered. CASM_<NAME>_PATH overrides the binary.
function installed(bin: string): boolean {
  const override = process.env[`CASM_${bin.toUpperCase()}_PATH`];
  if (override) return true;
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function availableProviders(): Provider[] {
  const all: [string, () => Provider][] = [
    ["claude", claudeProvider],
    ["codex", codexProvider],
    ["pi", piProvider],
    ["opencode", opencodeProvider],
  ];
  return all.filter(([bin]) => installed(bin)).map(([, make]) => make());
}

function parseListen(s: string): { host: string; port: number } {
  const i = s.lastIndexOf(":");
  if (i < 0) throw new Error(`--listen must be host:port, got "${s}"`);
  return { host: s.slice(0, i).replace(/^\[|\]$/g, ""), port: Number(s.slice(i + 1)) };
}

const usage = `usage:
  casm serve [--listen host:port] [--name n]
                                      (default ${DEFAULT_LISTEN}, or "listen" in ${join(home, "config.json")};
                                      name defaults to "name" there, $CASM_NAME, or the hostname)
                                      ("agentPrompt": false there turns off the host agent prompt, see casm agent-prompt)
                                      (writes ${join(home, LOCAL_FILE)}: this machine's CLI then uses this server)
  casm token create <name>            print a new client token
  casm token list
  casm token revoke <name>
  casm peer add <name> <ws-url> <token>   another casm server this one's agents may use (verified now)
  casm peer list [--probe]
  casm peer rm <name>`;

// The CLI on this machine uses the server through this file, so `casm -H <peer>`
// goes through the server's peers. A fresh token each start; the old one is revoked.
function writeLocalCredential(store: Store, url: string) {
  store.revokeToken(LOCAL_TOKEN);
  const file = join(home, LOCAL_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify({ url, token: store.createToken(LOCAL_TOKEN) }) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export async function serverCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { listen: { type: "string" }, name: { type: "string" }, help: { type: "boolean", short: "h" }, probe: { type: "boolean" }, json: { type: "boolean" }, host: { type: "string", short: "H" } },
  });
  const [cmd, sub, arg, ...rest] = positionals;
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, "casm.db"));

  if (values.help || !cmd) {
    console.log(usage);
  } else if (cmd === "serve") {
    const { host, port } = parseListen(values.listen ?? process.env.CASM_LISTEN ?? readConfig().listen ?? DEFAULT_LISTEN);
    const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
    const name = values.name ?? process.env.CASM_NAME ?? readConfig().name;
    const server = await startServer({ store, providers: availableProviders(), host, port, version: VERSION, name, log, home });
    log(`agents: ${server.agents.providerIds().join(", ") || "none found on PATH"}`);
    writeLocalCredential(store, server.url);
    if (store.listTokens().length === 1) log('no client tokens for other machines yet: run "casm token create <name>"');
    const stop = async () => {
      log("shutting down");
      await server.close();
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else if (cmd === "token" && sub === "create" && arg) {
    if (store.listTokens().some((t) => t.name === arg))
      (console.error(`a token named ${arg} already exists (casm token revoke ${arg} first, or pick another name)`), (process.exitCode = 1));
    else console.log(store.createToken(arg));
  } else if (cmd === "token" && sub === "list") {
    if (values.json) console.log(JSON.stringify(store.listTokens(), null, 2));
    else for (const t of store.listTokens()) console.log(`${t.name}\t${t.createdAt}`);
  } else if (cmd === "token" && sub === "revoke" && arg) {
    if (!store.revokeToken(arg)) (console.error(`no token named ${arg}`), (process.exitCode = 1));
  } else if (cmd === "peer" && sub === "add" && arg && rest.length === 2) {
    const [url, token] = rest;
    try {
      const info = await verifyPeer(url, token);
      if (info.id === store.serverId()) throw new Error("that is this server");
      store.setPeer({ name: arg, url, token, serverId: info.id });
      console.log(`added peer ${arg}: server "${info.name}" (${info.id}), agents: ${info.providers.join(", ") || "none"}`);
    } catch (e) {
      console.error(`casm: peer ${arg} not added: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  } else if (cmd === "peer" && sub === "list") {
    const pool = new PeerPool(store);
    const peers = store.listPeers();
    if (values.json) {
      // Never print peer tokens.
      const out = [];
      for (const p of peers) out.push({ name: p.name, url: p.url, serverId: p.serverId ?? null, ...(values.probe ? await pool.probe(p) : {}) });
      console.log(JSON.stringify(out, null, 2));
    } else if (!peers.length) console.error("no peers (add one with: casm peer add <name> <ws-url> <token>)");
    for (const p of values.json ? [] : peers) {
      const state = values.probe ? await pool.probe(p) : undefined;
      const status = state ? (state.reachable ? "  reachable" : `  unreachable: ${state.error}`) : "";
      console.log(`${p.name}\t${p.url}\t${p.serverId ?? "?"}${status}`);
    }
    pool.close();
  } else if (cmd === "peer" && sub === "rm" && arg) {
    if (!store.removePeer(arg)) (console.error(`no peer named ${arg}`), (process.exitCode = 1));
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
  if (cmd !== "serve") store.close();
}

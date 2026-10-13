// Server-side subcommands of `casm`:
//   casm serve [--listen host:port]
//   casm token create <name> | list | revoke <name>
//   casm peer add <name> <ws-url> <token> | list | rm <name>
import { mkdirSync, readFileSync } from "node:fs";
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
  casm token create <name>            print a new client token
  casm token list
  casm token revoke <name>
  casm peer add <name> <ws-url> <token>   another casm server this one's agents may use (verified now)
  casm peer list [--probe]
  casm peer rm <name>`;

export async function serverCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { listen: { type: "string" }, name: { type: "string" }, help: { type: "boolean", short: "h" }, probe: { type: "boolean" } },
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
    const server = await startServer({ store, providers: availableProviders(), host, port, version: VERSION, name, log });
    log(`agents: ${server.agents.providerIds().join(", ") || "none found on PATH"}`);
    if (store.listTokens().length === 0) log('no client tokens yet: run "casm token create <name>"');
    const stop = async () => {
      log("shutting down");
      await server.close();
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else if (cmd === "token" && sub === "create" && arg) {
    console.log(store.createToken(arg));
  } else if (cmd === "token" && sub === "list") {
    for (const t of store.listTokens()) console.log(`${t.name}\t${t.createdAt}`);
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
    for (const p of store.listPeers()) {
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

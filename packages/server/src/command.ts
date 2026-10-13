// Server-side subcommands of `casm`:
//   casm serve [--listen host:port]
//   casm token create <name> | list | revoke <name>
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./db.ts";
import { startServer } from "./server.ts";
import { execFileSync } from "node:child_process";
import { claudeProvider } from "./providers/claude.ts";
import { codexProvider } from "./providers/codex.ts";
import { opencodeProvider } from "./providers/opencode.ts";
import { piProvider } from "./providers/pi.ts";
import type { Provider } from "./providers/types.ts";

const VERSION = "0.0.1";
const DEFAULT_LISTEN = "127.0.0.1:7373";

const home = process.env.CASM_HOME ?? join(homedir(), ".casm-ng");

function readConfig(): { listen?: string } {
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
  casm serve [--listen host:port]     (default ${DEFAULT_LISTEN}, or "listen" in ${join(home, "config.json")})
  casm token create <name>            print a new client token
  casm token list
  casm token revoke <name>`;

export async function serverCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { listen: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [cmd, sub, arg] = positionals;
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, "casm.db"));

  if (values.help || !cmd) {
    console.log(usage);
  } else if (cmd === "serve") {
    const { host, port } = parseListen(values.listen ?? process.env.CASM_LISTEN ?? readConfig().listen ?? DEFAULT_LISTEN);
    const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
    const server = await startServer({ store, providers: availableProviders(), host, port, version: VERSION, log });
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
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
  if (cmd !== "serve") store.close();
}

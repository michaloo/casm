// Checkout-local casm instance. Never inherit the hosting agent's server routing.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? "serve";

if (command === "--help" || command === "-h") {
  console.log(`usage: npm run dev -- init | serve | <casm CLI arguments>

init creates a separate development database and client credential.
serve runs in the foreground; Ctrl-C stops only this instance.
Other commands always connect to this development instance.

CASM_DEV_HOME   state directory (default: <checkout>/.casm-dev)
CASM_DEV_PORT   loopback port (default: 7474)

Example: npm run dev -- --json agents
The development launcher does not install or manage services.`);
} else {
  // Resolve existing ancestors too, so aliases of a production state directory
  // cannot bypass the check when the final directory has not been created yet.
  function canonical(path: string): string {
    const absolute = resolve(path);
    if (existsSync(absolute)) return realpathSync(absolute);
    return join(canonical(dirname(absolute)), basename(absolute));
  }

  const home = canonical(process.env.CASM_DEV_HOME || join(repo, ".casm-dev"));
  const protectedHomes = [join(homedir(), ".casm-ng"), process.env.CASM_HOME].filter((p): p is string => !!p);
  if (protectedHomes.some((p) => canonical(p) === home))
    throw new Error("CASM_DEV_HOME must differ from the default and inherited CASM_HOME production directories");
  const port = Number(process.env.CASM_DEV_PORT ?? 7474);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CASM_DEV_PORT must be 1–65535");
  const credential = join(home, "development.json");
  const database = join(home, "casm.db");
  function readCredential(): string {
    if (!existsSync(credential) || !existsSync(database)) throw new Error("Run npm run dev -- init first (use a fresh directory if initialization was interrupted)");
    const { token } = JSON.parse(readFileSync(credential, "utf8"));
    if (typeof token !== "string" || !token.startsWith("casm_")) throw new Error("Invalid development credential");
    return token;
  }
  if (command === "service") throw new Error("Use the foreground dev server; this launcher never manages services");
  if (command === "serve" && args.length > 1) throw new Error("Set CASM_DEV_PORT to change the dev listener");

  // Set before loading the CLI/server modules, which capture their home at import.
  process.env.CASM_HOME = home;
  for (const key of ["CASM_URL", "CASM_TOKEN", "CASM_HOST", "CASM_LISTEN", "CASM_NAME", "CASM_SERVER_ID", "CASM_SERVER_NAME", "CASM_AGENT_ID"])
    delete process.env[key];

  if (command === "init") {
    if (existsSync(credential)) {
      readCredential();
      console.log(`Development instance already initialized: ${home}`);
    } else {
      if (existsSync(database)) throw new Error("Refusing to adopt an existing database without a development credential; choose an empty CASM_DEV_HOME");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Exclusive marker prevents concurrent initializers from mutating the DB.
      writeFileSync(credential, "", { flag: "wx", mode: 0o600 });
      const { Store } = await import("../packages/server/src/db.ts");
      const store = new Store(database);
      try {
        const token = store.createToken("development-launcher");
        writeFileSync(credential, JSON.stringify({ token }) + "\n");
      } finally {
        store.close();
      }
      console.log(`Initialized development instance: ${home}`);
    }
  } else {
    const token = readCredential();
    process.env.CASM_URL = `ws://127.0.0.1:${port}`;
    process.env.CASM_TOKEN = token;
    process.argv = [process.execPath, join(repo, "packages/cli/src/main.ts"),
      ...(command === "serve" ? ["serve", "--listen", `127.0.0.1:${port}`, "--name", "casm-dev"] : args)];
    await import("../packages/cli/src/main.ts");
  }
}

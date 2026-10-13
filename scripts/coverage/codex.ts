// Codex inventory from the installed CLI's own protocol schema:
// `codex app-server generate-json-schema`. Client requests come from the
// stable schema; what the server sends (notifications, requests) from the
// experimental one, because casm initializes with `experimentalApi: true`.
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TMP_DIR, mainExtract, run, which, type Inventory, type InventoryEntry } from "./lib.ts";

type Schema = { oneOf?: Schema[]; anyOf?: Schema[]; properties?: Record<string, Schema>; enum?: string[]; const?: string; definitions?: Record<string, Schema>; title?: string };

function methods(file: string): string[] {
  const s = JSON.parse(readFileSync(file, "utf8")) as Schema;
  return (s.oneOf ?? s.anyOf ?? []).map((v) => v.properties?.method?.enum?.[0] ?? v.properties?.method?.const).filter((m): m is string => !!m);
}

function variants(defs: Record<string, Schema>, name: string): string[] {
  const d = defs[name];
  if (!d) throw new Error(`codex: ${name} not found in the v2 schema`);
  return (d.oneOf ?? d.anyOf ?? []).map((v) => v.properties?.type?.enum?.[0] ?? v.properties?.type?.const).filter((t): t is string => !!t);
}

export async function extract(): Promise<Inventory | null> {
  const bin = process.env.CASM_CODEX_PATH ?? which("codex");
  if (!bin) return null;
  const version = run(bin, ["--version"]).trim();
  mkdirSync(TMP_DIR, { recursive: true });
  const dir = mkdtempSync(join(TMP_DIR, "codex-"));
  try {
    const stable = join(dir, "stable");
    const exp = join(dir, "experimental");
    run(bin, ["app-server", "generate-json-schema", "--out", stable]);
    run(bin, ["app-server", "generate-json-schema", "--experimental", "--out", exp]);
    const items: InventoryEntry[] = [];
    const stableSet = (f: string) => new Set(methods(join(stable, f)));

    for (const m of methods(join(stable, "ClientRequest.json"))) items.push({ id: `request:${m}`, kind: "clientRequest" });
    for (const m of methods(join(stable, "ClientNotification.json"))) items.push({ id: `clientNotification:${m}`, kind: "clientNotification" });
    const stableNotes = stableSet("ServerNotification.json");
    for (const m of methods(join(exp, "ServerNotification.json")))
      items.push({ id: `notification:${m}`, kind: "serverNotification", ...(stableNotes.has(m) ? {} : { note: "experimental" }) });
    const stableReqs = stableSet("ServerRequest.json");
    for (const m of methods(join(exp, "ServerRequest.json")))
      items.push({ id: `serverRequest:${m}`, kind: "serverRequest", ...(stableReqs.has(m) ? {} : { note: "experimental" }) });

    const defs = (JSON.parse(readFileSync(join(exp, "codex_app_server_protocol.v2.schemas.json"), "utf8")) as Schema).definitions ?? {};
    for (const t of variants(defs, "ThreadItem")) items.push({ id: `item:${t}`, kind: "threadItem" });
    for (const t of variants(defs, "UserInput")) items.push({ id: `input:${t}`, kind: "userInput" });
    return { source: "codex", version, from: "codex app-server generate-json-schema", items };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await mainExtract(extract, "codex");

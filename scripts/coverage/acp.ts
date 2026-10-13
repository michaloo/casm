// ACP inventory from the published schema in the npm package
// @agentclientprotocol/sdk (schema/schema.json, the stable protocol).
// `npm pack` downloads the tarball into /tmp/casm-coverage/acp; it is never
// added as a dependency. `extract({ offline: true })` only uses that cache.
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_DIR, mainExtract, run, type Inventory, type InventoryEntry } from "./lib.ts";

const PKG = "@agentclientprotocol/sdk";
export const ACP_CACHE = join(TMP_DIR, "acp");

type Schema = { oneOf?: Schema[]; anyOf?: Schema[]; properties?: Record<string, Schema>; const?: string; "x-method"?: string; "x-side"?: string };

function semverCmp(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// Newest cached tarball, or null.
export function cachedTarball(): { file: string; version: string } | null {
  if (!existsSync(ACP_CACHE)) return null;
  const found = readdirSync(ACP_CACHE)
    .map((f) => /^agentclientprotocol-sdk-(.+)\.tgz$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ file: join(ACP_CACHE, m[0]), version: m[1] }))
    .sort((a, b) => semverCmp(b.version, a.version));
  return found[0] ?? null;
}

export function acpVersionCmp(a: string, b: string) {
  return semverCmp(a, b);
}

function download(): { file: string; version: string } {
  mkdirSync(ACP_CACHE, { recursive: true });
  const version = run("npm", ["view", PKG, "version"]).trim();
  const file = join(ACP_CACHE, `agentclientprotocol-sdk-${version}.tgz`);
  if (!existsSync(file)) run("npm", ["pack", `${PKG}@${version}`, "--pack-destination", ACP_CACHE, "--silent"], { cwd: ACP_CACHE });
  return { file, version };
}

export function fromSchema(schema: { $defs: Record<string, Schema> }, version: string): Inventory {
  const d = schema.$defs;
  const items: InventoryEntry[] = [];
  for (const [name, def] of Object.entries(d)) {
    const method = def["x-method"];
    if (!method || /Response$/.test(name)) continue;
    const side = def["x-side"];
    // x-side names who handles the method: "agent" = client -> agent.
    const kind = side === "agent" ? "agentMethod" : side === "client" ? "clientMethod" : "protocolMethod";
    const notification = /Notification$/.test(name);
    items.push({ id: `${side === "agent" ? "agent" : side === "client" ? "client" : "protocol"}:${method}`, kind, note: notification ? `notification (${name})` : name });
  }
  const variants = (name: string, field: string) => {
    const s = d[name];
    if (!s) throw new Error(`acp: ${name} not found in schema.json`);
    return (s.oneOf ?? s.anyOf ?? []).map((v) => v.properties?.[field]?.const).filter((x): x is string => !!x);
  };
  for (const u of variants("SessionUpdate", "sessionUpdate")) items.push({ id: `update:${u}`, kind: "sessionUpdate" });
  for (const t of variants("ContentBlock", "type")) items.push({ id: `content:${t}`, kind: "contentBlock" });
  for (const t of variants("ToolCallContent", "type")) items.push({ id: `toolContent:${t}`, kind: "toolCallContent" });
  return { source: "acp", version: `${PKG} ${version}`, from: `${PKG}/schema/schema.json`, items };
}

export function extractFromTarball(file: string, version: string): Inventory {
  mkdirSync(TMP_DIR, { recursive: true });
  const dir = mkdtempSync(join(TMP_DIR, "acp-x-"));
  try {
    run("tar", ["xzf", file, "-C", dir, "package/schema/schema.json"]);
    return fromSchema(JSON.parse(readFileSync(join(dir, "package/schema/schema.json"), "utf8")), version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function extract(opts: { offline?: boolean } = {}): Promise<Inventory | null> {
  let tar: { file: string; version: string } | null = null;
  if (!opts.offline) {
    try {
      tar = download();
    } catch (e) {
      console.error(`acp: npm download failed (${e instanceof Error ? e.message.split("\n")[0] : e}); trying the cache`);
    }
  }
  tar ??= cachedTarball();
  return tar ? extractFromTarball(tar.file, tar.version) : null;
}

if (import.meta.main) await mainExtract(() => extract(), "acp");

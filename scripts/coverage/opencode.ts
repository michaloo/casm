// OpenCode inventory from the installed server's OpenAPI document: starts
// `opencode serve` on a free loopback port, fetches GET /doc, stops it.
// Endpoints are limited to the v1 session-facing API that casm talks to;
// the parallel /api/* (v2) surface, TUI control, PTY, auth and workspace
// administration are out of scope for the inventory.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mainExtract, run, which, type Inventory, type InventoryEntry } from "./lib.ts";

type Schema = { $ref?: string; oneOf?: Schema[]; anyOf?: Schema[]; properties?: Record<string, Schema>; enum?: string[]; const?: string };
type Doc = {
  paths: Record<string, Record<string, { operationId?: string; requestBody?: { content?: Record<string, { schema?: Schema }> } }>>;
  components: { schemas: Record<string, Schema> };
};

// Session-facing operations (operationId prefixes).
const OPERATION_SCOPE = /^(session\.|permission\.|question\.|part\.|event\.subscribe$|global\.event$|app\.agents$|app\.skills$|command\.list$|config\.providers$|config\.get$|provider\.list$)/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function fetchDoc(bin: string): Promise<Doc> {
  const port = await freePort();
  const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  let exited = false;
  proc.once("exit", () => (exited = true));
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`opencode serve exited: ${stderr.trim()}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/doc`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return (await res.json()) as Doc;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("opencode serve did not answer GET /doc within 30 s");
  } finally {
    if (!exited) {
      const gone = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 3000);
      await gone;
      clearTimeout(t);
    }
  }
}

function refName(s: Schema): string {
  return s.$ref ? s.$ref.split("/").pop()! : "";
}

function typeLiteral(s: Schema | undefined): string | undefined {
  return s?.const ?? s?.enum?.[0];
}

export async function extract(): Promise<Inventory | null> {
  const bin = process.env.CASM_OPENCODE_PATH ?? which("opencode");
  if (!bin) return null;
  const version = `opencode ${run(bin, ["--version"]).trim()}`;
  const doc = await fetchDoc(bin);
  const S = doc.components.schemas;
  const union = (name: string) => {
    const s = S[name];
    if (!s) throw new Error(`opencode: schema ${name} not found`);
    return (s.oneOf ?? s.anyOf ?? []).map((v) => S[refName(v)] ?? v);
  };
  const items: InventoryEntry[] = [];

  for (const e of union("Event")) {
    const t = typeLiteral(e.properties?.type);
    if (t) items.push({ id: `event:${t}`, kind: "event" });
  }
  for (const p of union("Part")) {
    const t = typeLiteral(p.properties?.type);
    if (t) items.push({ id: `part:${t}`, kind: "part" });
  }
  for (const m of union("Message")) {
    const r = typeLiteral(m.properties?.role);
    if (r) items.push({ id: `message:${r}`, kind: "message" });
  }
  // Prompt input parts (POST /session/{id}/prompt_async body).
  const body = doc.paths["/session/{sessionID}/prompt_async"]?.post?.requestBody?.content?.["application/json"]?.schema;
  const partsSchema = body?.properties?.parts as (Schema & { items?: Schema }) | undefined;
  for (const v of partsSchema?.items?.anyOf ?? partsSchema?.items?.oneOf ?? []) {
    const t = typeLiteral(S[refName(v)]?.properties?.type);
    if (t) items.push({ id: `input:${t}`, kind: "inputPart", note: refName(v) });
  }
  for (const [path, ops] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(ops))
      if (op.operationId && OPERATION_SCOPE.test(op.operationId))
        items.push({ id: `op:${op.operationId}`, kind: "endpoint", note: `${method.toUpperCase()} ${path}` });

  for (const kind of ["event", "part", "message", "inputPart", "endpoint"])
    if (!items.some((i) => i.kind === kind)) throw new Error(`opencode: no ${kind} ids found; the OpenAPI layout changed`);
  return { source: "opencode", version, from: "opencode serve: GET /doc (OpenAPI)", items };
}

if (import.meta.main) await mainExtract(extract, "opencode");

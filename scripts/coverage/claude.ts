// Claude Code inventory from the installed Agent SDK's type declarations
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts), plus the Anthropic
// SDK types it re-uses for message content.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Dts, stringLiterals, type Member } from "./dts.ts";
import { ROOT, mainExtract, type Inventory, type InventoryEntry } from "./lib.ts";

const SDK_DIR = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk");
const ANTHROPIC_DIR = join(ROOT, "node_modules/@anthropic-ai/sdk");

function literal(ms: Member[], name: string): string[] {
  const m = ms.find((x) => x.name === name);
  return m ? stringLiterals(m.type) : [];
}

export async function extract(): Promise<Inventory | null> {
  const dtsPath = join(SDK_DIR, "sdk.d.ts");
  if (!existsSync(dtsPath)) return null;
  const sdk = new Dts(readFileSync(dtsPath, "utf8"));
  const version = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")).version as string;
  const items: InventoryEntry[] = [];

  // 1. SDKMessage union members: `type`, plus `subtype` where one exists.
  const members = sdk.unionNames("SDKMessage");
  if (!members.length) throw new Error("claude: SDKMessage union not found in sdk.d.ts");
  for (const name of members) {
    const shapes = sdk.objects(name);
    if (!shapes.length) throw new Error(`claude: cannot resolve ${name}`);
    for (const shape of shapes) {
      const types = literal(shape, "type");
      const subtypes = literal(shape, "subtype");
      for (const t of types) {
        if (subtypes.length) for (const s of subtypes) items.push({ id: `sdkmessage:${t}/${s}`, kind: "sdkmessage", note: name });
        else items.push({ id: `sdkmessage:${t}`, kind: "sdkmessage", note: name });
      }
    }
  }

  // 2. Content blocks: assistant output (BetaContentBlock) and transcript input
  // (ContentBlockParam), plus streaming deltas.
  const anthropic = (rel: string) => new Dts(readFileSync(join(ANTHROPIC_DIR, rel), "utf8"));
  const beta = anthropic("resources/beta/messages/messages.d.ts");
  const std = anthropic("resources/messages/messages.d.ts");
  const blockTypes = (dts: Dts, union: string, kind: string, note: string) => {
    const names = dts.unionNames(union);
    if (!names.length) throw new Error(`claude: ${union} not found`);
    for (const n of names)
      for (const shape of dts.objects(n)) for (const t of literal(shape, "type")) items.push({ id: `${kind}:${t}`, kind, note: `${note} (${n})` });
  };
  blockTypes(beta, "BetaContentBlock", "block", "assistant content");
  blockTypes(std, "ContentBlockParam", "block", "user/transcript content");
  blockTypes(beta, "BetaRawContentBlockDelta", "streamdelta", "stream_event content_block_delta");
  blockTypes(beta, "BetaRawMessageStreamEvent", "streamevent", "stream_event");

  // 3. Interaction callbacks on Options, and hook events.
  const options = sdk.objects("Options")[0] ?? [];
  for (const m of options)
    if (m.name === "canUseTool" || /^on[A-Z]/.test(m.name)) items.push({ id: `callback:${m.name}`, kind: "callback", note: m.type.replace(/;$/, "").trim() });
  const hooks = sdk.literals("HookEvent");
  if (!hooks.length) throw new Error("claude: HookEvent not found");
  for (const h of hooks) items.push({ id: `hook:${h}`, kind: "hook" });

  // 4. Query control methods.
  const query = sdk.objects("Query")[0] ?? [];
  const methods = query.filter((m) => m.method);
  if (!methods.length) throw new Error("claude: Query interface not found");
  for (const m of methods) items.push({ id: `query:${m.name}`, kind: "query" });

  return { source: "claude", version: `claude-agent-sdk ${version}`, from: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts", items };
}

if (import.meta.main) await mainExtract(extract, "claude");

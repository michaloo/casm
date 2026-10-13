// pi inventory from the RPC docs shipped with the installed package:
// docs/rpc-commands.md (commands), docs/json.md (session events and
// assistantMessageEvent types), docs/rpc-extension-ui.md (UI requests),
// docs/message-types.md (roles, content blocks), docs/session-format.md
// (session file entries, which history reads).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mainExtract, packageRoot, which, type Inventory, type InventoryEntry } from "./lib.ts";

function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`pi docs: section "${heading}" not found`);
  const level = heading.match(/^#+/)![0].length;
  const rest = md.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end < 0 ? rest : rest.slice(0, end);
}

// `### name` headings inside a block of markdown.
function h3(md: string): string[] {
  return [...md.matchAll(/^### ([^\n]+)$/gm)].map((m) => m[1].trim());
}

// First-column backticked names of markdown tables.
function tableNames(md: string): string[] {
  return [...md.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
}

export function piPackageDir(): string | null {
  const bin = process.env.CASM_PI_PATH ?? which("pi");
  if (!bin) return null;
  const root = packageRoot(bin, /pi-coding-agent$/);
  return root && existsSync(join(root, "docs/rpc-commands.md")) ? root : null;
}

export async function extract(): Promise<Inventory | null> {
  const root = piPackageDir();
  if (!root) return null;
  const doc = (f: string) => readFileSync(join(root, "docs", f), "utf8");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const items: InventoryEntry[] = [];

  // Commands: every ### under the ## sections, except the reference appendix.
  const commands = doc("rpc-commands.md");
  for (const block of commands.split(/\n## /).slice(1)) {
    const title = block.slice(0, block.indexOf("\n"));
    if (/object$/i.test(title)) continue;
    for (const name of h3(block)) if (/^[a-z_]+$/.test(name)) items.push({ id: `command:${name}`, kind: "command", note: title });
  }

  // Session events: tables in json.md, plus the RPC-only events named in code blocks.
  const json = doc("json.md");
  const streaming = section(json, "### Reconstruct streaming messages");
  for (const name of tableNames(json.replace(streaming, ""))) items.push({ id: `event:${name}`, kind: "event" });
  // Event names in example records (one-line or pretty-printed). `session` is
  // the JSON-mode header, which RPC mode never sends.
  for (const m of json.matchAll(/^(?:\{"type":"|  "type": ")([a-z_]+)"/gm))
    if (m[1] !== "session") items.push({ id: `event:${m[1]}`, kind: "event" });
  for (const name of tableNames(streaming)) items.push({ id: `assistantEvent:${name}`, kind: "assistantMessageEvent", note: "message_update.assistantMessageEvent" });

  // Extension UI requests.
  for (const name of h3(section(doc("rpc-extension-ui.md"), "## Requests from Pi"))) items.push({ id: `ui:${name}`, kind: "extensionUi" });

  // Messages and content blocks.
  const messages = doc("message-types.md");
  for (const m of messages.matchAll(/^\s+role: "([A-Za-z]+)";/gm)) items.push({ id: `message:${m[1]}`, kind: "message" });
  for (const m of section(messages, "## Content blocks").matchAll(/^\s+type: "([A-Za-z]+)";/gm)) items.push({ id: `content:${m[1]}`, kind: "content" });

  // Session file entries.
  const format = doc("session-format.md");
  for (const m of section(format, "## Entry Types").matchAll(/^\{"type":"([a-z_]+)"/gm)) items.push({ id: `entry:${m[1]}`, kind: "sessionEntry" });

  // A doc reshuffle must fail loudly, not look like every id was removed.
  for (const kind of ["command", "event", "assistantMessageEvent", "extensionUi", "message", "content", "sessionEntry"])
    if (!items.some((i) => i.kind === kind)) throw new Error(`pi docs: no ${kind} ids found; the doc layout changed`);
  return { source: "pi", version: `pi-coding-agent ${version}`, from: "pi-coding-agent/docs (rpc-commands, json, rpc-extension-ui, message-types, session-format)", items };
}

if (import.meta.main) await mainExtract(extract, "pi");

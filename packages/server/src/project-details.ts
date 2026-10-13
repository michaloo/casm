// Per-project details that live in the folder or in the agents' own stores:
// AGENTS.md and each agent's memories.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, type AgentMemories, type MemoryEntry, type ProviderId } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import type { Provider } from "./providers/types.ts";

export async function readAgentsMd(folder: string): Promise<{ path: string; content: string | null }> {
  const path = join(folder, "AGENTS.md");
  try {
    return { path, content: await readFile(path, "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null };
    throw e;
  }
}

export async function writeAgentsMd(folder: string, content: string): Promise<{ path: string; content: string }> {
  const path = join(folder, "AGENTS.md");
  await writeFile(path, content);
  return { path, content };
}

// One provider failing to read its store doesn't hide the others.
export async function listMemories(providers: Provider[], folder: string, log?: (msg: string) => void): Promise<AgentMemories[]> {
  const found = await Promise.all(
    providers.map(async (p) => {
      if (!p.memories) return null;
      try {
        const m = await p.memories(folder);
        return m && { provider: p.id, ...m };
      } catch (e) {
        log?.(`${p.id} memories: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    }),
  );
  return found.filter((m): m is AgentMemories => m !== null);
}

function editable(providers: Provider[], id: ProviderId, op: "updateMemory" | "deleteMemory"): Provider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new RpcError(ErrorCode.Conflict, `provider "${id}" is not available on this host`);
  if (!p[op]) throw new RpcError(ErrorCode.Conflict, `${id} memories are read-only`);
  return p;
}

export function updateMemory(providers: Provider[], folder: string, id: ProviderId, entryId: string, text: string): Promise<MemoryEntry> {
  return editable(providers, id, "updateMemory").updateMemory!(folder, entryId, text);
}

export function deleteMemory(providers: Provider[], folder: string, id: ProviderId, entryId: string): Promise<void> {
  return editable(providers, id, "deleteMemory").deleteMemory!(folder, entryId);
}

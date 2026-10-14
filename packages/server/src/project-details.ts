// Per-project details that live in the folder or in the agents' own stores:
// AGENTS.md and each agent's memories.
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ErrorCode, type AgentMemories, type MemoryEntry, type ProviderId } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import type { Provider } from "./providers/types.ts";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const writes = new Map<string, Promise<unknown>>();

export async function readAgentsMd(folder: string) {
  return readInstructionFile(join(folder, "AGENTS.md"));
}

export async function readInstructionFile(path: string) {
  try {
    const content = await readFile(path, "utf8");
    return { path, content, sha256: sha256(content) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null, sha256: null };
    throw e;
  }
}

export async function writeAgentsMd(folder: string, content: string, expectedSha256?: string | null): Promise<{ path: string; content: string }> {
  return writeInstructionFile(join(folder, "AGENTS.md"), content, expectedSha256);
}

export async function writeInstructionFile(path: string, content: string, expectedSha256?: string | null, validate?: () => Promise<void>): Promise<{ path: string; content: string }> {
  // Serialize server writes so two saves against the same version cannot both win.
  const previous = writes.get(path);
  const write = (async () => {
    await previous?.catch(() => {});
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const mode = await stat(path).then((s) => s.mode & 0o777, (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return 0o600;
        throw e;
      });
      await writeFile(temp, content, { flag: "wx", mode });
      await validate?.();
      const current = await readInstructionFile(path);
      if (expectedSha256 !== undefined && current.sha256 !== expectedSha256) {
        throw new RpcError(ErrorCode.Conflict, "AGENTS.md changed since it was read; reload before saving.");
      }
      await rename(temp, path);
      return { path, content };
    } finally {
      await unlink(temp).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    }
  })();
  writes.set(path, write);
  try {
    return await write;
  } finally {
    if (writes.get(path) === write) writes.delete(path);
  }
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

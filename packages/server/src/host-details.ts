// Standard global provider instruction files. Precedence references are recorded
// in docs/host-settings.md; custom project rules are outside this global view.
import { lstat, mkdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ErrorCode, type HostAgentsMdFile, type ProviderId } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import { readInstructionFile, writeInstructionFile } from "./project-details.ts";

type Options = { home?: string; env?: NodeJS.ProcessEnv };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

// Also resolve dangling links and nonexistent parents, so creating a missing
// target never replaces an existing symlink with a regular file.
async function canonical(path: string, hops = 0): Promise<string> {
  if (hops > 40) throw new RpcError(ErrorCode.InvalidParams, "Too many instruction-file symlinks");
  try { return await realpath(path); } catch (e) { if (!missing(e)) throw e; }
  try {
    if ((await lstat(path)).isSymbolicLink()) return canonical(resolve(dirname(path), await readlink(path)), hops + 1);
  } catch (e) { if (!missing(e)) throw e; }
  return join(await canonical(dirname(path), hops + 1), basename(path));
}

async function first(paths: string[], fallback: string, nonempty = false): Promise<string> {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile() && (!nonempty || (await readFile(path, "utf8")).trim())) return path;
    } catch (e) { if (!missing(e)) throw e; }
  }
  return fallback;
}

export async function hostAgentsMd({ home = homedir(), env = process.env }: Options = {}): Promise<HostAgentsMdFile[]> {
  const dir = (value: string | undefined, fallback: string) => value ? resolve(value.startsWith("~/") ? join(home, value.slice(2)) : value) : fallback;
  const claude = join(dir(env.CLAUDE_CONFIG_DIR, join(home, ".claude")), "CLAUDE.md");
  const codex = dir(env.CODEX_HOME, join(home, ".codex"));
  const pi = dir(env.PI_CODING_AGENT_DIR, join(home, ".pi", "agent"));
  const opencode = join(dir(env.XDG_CONFIG_HOME, join(home, ".config")), "opencode", "AGENTS.md");
  const disabled = (value?: string) => value === "1" || value === "true";
  const sources: { provider: ProviderId; path: string }[] = [
    { provider: "claude", path: claude },
    { provider: "codex", path: await first([join(codex, "AGENTS.override.md"), join(codex, "AGENTS.md")], join(codex, "AGENTS.md"), true) },
    { provider: "opencode", path: await first([opencode, ...(!disabled(env.OPENCODE_DISABLE_CLAUDE_CODE) && !disabled(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) ? [join(home, ".claude", "CLAUDE.md")] : [])], opencode) },
    { provider: "pi", path: await first(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].map((name) => join(pi, name)), join(pi, "AGENTS.md")) },
  ];
  const files = new Map<string, HostAgentsMdFile>();
  for (const source of sources) {
    const path = await canonical(source.path);
    const existing = files.get(path);
    if (existing) existing.sources.push(source);
    else files.set(path, { ...await readInstructionFile(path), sources: [source] });
  }
  return [...files.values()];
}

export async function setHostAgentsMd(path: string, content: string, expectedSha256: string | null, options?: Options): Promise<HostAgentsMdFile> {
  const discover = async () => (await hostAgentsMd(options)).find((file) => file.path === path);
  const file = await discover();
  if (!file) throw new RpcError(ErrorCode.NotFound, "This is no longer a global instruction file; reload the file list.");
  await mkdir(dirname(path), { recursive: true });
  await writeInstructionFile(path, content, expectedSha256, async () => {
    if (!await discover()) throw new RpcError(ErrorCode.Conflict, "Instruction file target changed; reload before saving.");
  });
  return { ...file, ...await readInstructionFile(path) };
}

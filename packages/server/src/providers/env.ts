import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@casm/protocol";
import type { ProviderContext } from "./types.ts";

// The server's runtime mode must not control agents' npm installs or builds.
// Explicit per-agent settings still take precedence over inherited defaults.
export function providerEnv(overrides?: Record<string, string>): Record<string, string> {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return { ...env, ...overrides } as Record<string, string>;
}

// Persist only store location, never arbitrary environment/credentials.
export function providerStoreContext(provider: ProviderId, context?: ProviderContext): ProviderContext | undefined {
  if (provider === "codex") return { env: { CODEX_HOME: context?.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex") } };
  if (provider === "claude") return { env: { CLAUDE_CONFIG_DIR: context?.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") } };
  return undefined;
}

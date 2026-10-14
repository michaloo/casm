import type { AgentProviderId, ProviderId } from "@casm/protocol";
import claude from "./assets/providers/claude.svg";
import codex from "./assets/providers/codex.svg";
import pi from "./assets/providers/pi.svg";

const marks: Record<ProviderId, string> = { claude, codex, pi };
export const providerNames: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
// Agents of retired providers stay listed (Agent.unavailable says why).
const retiredNames: Record<string, string> = { opencode: "OpenCode (removed)" };

export function providerName(provider: AgentProviderId): string {
  return providerNames[provider as ProviderId] ?? retiredNames[provider] ?? provider;
}

/** Native app template marks, tinted by CSS and served from the web bundle. */
export function ProviderIcon({ provider }: { provider: AgentProviderId }) {
  const mark = marks[provider as ProviderId];
  if (!mark) return <span className="provider-icon provider-icon-retired" role="img" aria-label={providerName(provider)}>?</span>;
  return <span className={`provider-icon provider-icon-${provider}`} role="img"
    aria-label={providerNames[provider as ProviderId]} style={{ maskImage: `url(${JSON.stringify(mark)})`, WebkitMaskImage: `url(${JSON.stringify(mark)})` }} />;
}

import type { ProviderId } from "@casm/protocol";
import claude from "./assets/providers/claude.svg";
import codex from "./assets/providers/codex.svg";
import pi from "./assets/providers/pi.svg";
import opencode from "./assets/providers/opencode.svg";

const marks = { claude, codex, pi, opencode };
export const providerNames = { claude: "Claude", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

/** Native app template marks, tinted by CSS and served from the web bundle. */
export function ProviderIcon({ provider }: { provider: ProviderId }) {
  return <span className={`provider-icon provider-icon-${provider}`} role="img"
    aria-label={providerNames[provider]} style={{ maskImage: `url(${JSON.stringify(marks[provider])})`, WebkitMaskImage: `url(${JSON.stringify(marks[provider])})` }} />;
}

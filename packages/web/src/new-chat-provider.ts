import type { ProviderId } from "@casm/protocol";
export const newChatProviders: { id: ProviderId; label: string }[] = [
  { id: "codex", label: "Codex (OpenAI)" }, { id: "claude", label: "Claude" },
  { id: "opencode", label: "OpenCode" }, { id: "pi", label: "Pi" },
];
export function readNewChatProvider(storage: Pick<Storage, "getItem">): ProviderId {
  try {
    const value = storage.getItem("casm.new-chat-provider");
    return newChatProviders.find(p => p.id === value)?.id ?? "codex";
  } catch { return "codex"; }
}
export function writeNewChatProvider(storage: Pick<Storage, "setItem">, provider: ProviderId) {
  try { storage.setItem("casm.new-chat-provider", provider); } catch { /* Device storage unavailable. */ }
}

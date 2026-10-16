// How many chat transcripts this device keeps in memory, the open one
// included: more makes switching back instant, fewer uses less memory. Chats
// beyond it read their transcript again (offline copy, then server) on reopen.
export type ChatMemory = "5" | "20" | "all";
export const chatMemoryChoices: { value: ChatMemory; label: string; hint: string }[] = [
  { value: "5", label: "Recent 5", hint: "Least memory. Older chats reload when reopened." },
  { value: "20", label: "Recent 20", hint: "Instant switching between the chats in use." },
  { value: "all", label: "All", hint: "Every opened chat stays loaded until the page reloads." },
];
const storageKey = "casm.chat-memory";
export const defaultChatMemory: ChatMemory = "20";
export function readChatMemory(storage: Pick<Storage, "getItem">): ChatMemory {
  try {
    const value = storage.getItem(storageKey);
    return chatMemoryChoices.some((c) => c.value === value) ? value as ChatMemory : defaultChatMemory;
  } catch { return defaultChatMemory; }
}
export function writeChatMemory(storage: Pick<Storage, "setItem">, value: ChatMemory) {
  try { storage.setItem(storageKey, value); } catch { /* Private browsing or full storage. */ }
}
// Chats kept besides the open one.
export const recentChats = (memory: ChatMemory) => memory === "all" ? Infinity : Number(memory) - 1;

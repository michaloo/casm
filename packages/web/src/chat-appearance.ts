export type ChatAppearance = { unreadIndicators: boolean; recentFirst: boolean };
const key = "casm.chat-appearance";
export function readChatAppearance(storage: Pick<Storage, "getItem">): ChatAppearance {
  try {
    const saved = JSON.parse(storage.getItem(key) ?? "null");
    return { unreadIndicators: saved?.unreadIndicators !== false, recentFirst: saved?.recentFirst !== false };
  } catch { return { unreadIndicators: true, recentFirst: true }; }
}
export function writeChatAppearance(storage: Pick<Storage, "setItem">, value: ChatAppearance) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* Optional device preference. */ }
}

import type { Chat } from "./state";
const pending = new Map<Chat, ReturnType<typeof setTimeout>>();
export function restoreDraft(c: Chat, host: string, id: string) {
  const storageKey = `casm.draft:${JSON.stringify([host, id])}`;
  if (c.draftStorageKey === storageKey) return;
  c.draftStorageKey = storageKey;
  try {
    c.input = localStorage.getItem(storageKey) ?? c.input;
  } catch {}
}
export function saveDraft(c: Chat, immediate = false) {
  clearTimeout(pending.get(c));
  pending.delete(c);
  if (!c.draftStorageKey) return;
  const write = () => {
    pending.delete(c);
    try {
      if (c.input) localStorage.setItem(c.draftStorageKey!, c.input);
      else localStorage.removeItem(c.draftStorageKey!);
    } catch {}
  };
  if (immediate) write();
  else pending.set(c, setTimeout(write, 200));
}
export function flushDrafts() {
  for (const c of pending.keys()) saveDraft(c, true);
}

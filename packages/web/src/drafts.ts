import type { Chat } from "./state";
const pending = new Map<Chat, ReturnType<typeof setTimeout>>();
export function restoreDraft(c: Chat, host: string, id: string) {
  const storageKey = `casm.draft:${JSON.stringify([host, id])}`;
  if (c.draftStorageKey === storageKey) return;
  c.draftStorageKey = storageKey;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      try {
        const draft = JSON.parse(stored);
        if (draft?.version === 1 && typeof draft.text === "string") {
          c.input = draft.text;
          c.images = Array.isArray(draft.images) ? draft.images.filter((image: any) =>
            typeof image?.mediaType === "string" && typeof image?.data === "string") : [];
          return;
        }
      } catch {}
      c.input = stored;
    }
  } catch {}
}
export function saveDraft(c: Chat, immediate = false) {
  clearTimeout(pending.get(c));
  pending.delete(c);
  if (!c.draftStorageKey) return;
  const write = () => {
    pending.delete(c);
    try {
      // Bound encoded image storage across every agent draft, while keeping all
      // attachments in memory for the current session.
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith("casm.draft:") || key === c.draftStorageKey) continue;
        try { total += JSON.stringify(JSON.parse(localStorage.getItem(key)!).images ?? []).length; } catch {}
      }
      const images = total + JSON.stringify(c.images).length <= 1_000_000 ? c.images : [];
      if (c.input || images.length) localStorage.setItem(c.draftStorageKey!, JSON.stringify({ version: 1, text: c.input, images }));
      else localStorage.removeItem(c.draftStorageKey!);
    } catch {}
  };
  if (immediate) write();
  else pending.set(c, setTimeout(write, 200));
}
export function flushDrafts() {
  for (const c of pending.keys()) saveDraft(c, true);
}

import type { Chat } from "./state";
import type { DraftFile } from "./attach";
const pending = new Map<Chat, ReturnType<typeof setTimeout>>();

// Attached files of drafts, kept across reloads in IndexedDB (localStorage
// holds only strings, and files are large): one record per draft, written only
// when its file list changes and deleted once it is empty (sent or removed).
// The newest drafts keep theirs up to FILES_BYTES in all; beyond that a draft's
// files stay in memory for this session only. Upload ids are not kept: the
// server's uploads expire, so after a reload the files go up again.
export const FILES_BYTES = 200 * 1024 * 1024;
// Records of drafts not changed for this long are dropped.
const FILES_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
// Bytes rather than File objects: WebKit can't store a File in IndexedDB.
type StoredFile = { name: string; type: string; lastModified: number; data: ArrayBuffer };
type FilesRecord = { files: StoredFile[]; bytes: number; savedAt: number };
const written = new WeakMap<Chat, DraftFile[]>();
let filesChanged: () => void = () => {};
/** Called when a draft's files arrive from storage, to redraw. */
export function onDraftFiles(listener: () => void) { filesChanged = listener; }

let filesDb: Promise<IDBDatabase | null> | undefined;
function openFilesDb(): Promise<IDBDatabase | null> {
  return (filesDb ??= new Promise<IDBDatabase | null>((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    const open = indexedDB.open("casm-drafts", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("files");
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
      void prune(db);
    };
    // Private browsing or a blocked database: files stay in memory.
    open.onerror = () => resolve(null);
  }));
}
function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction("files", mode);
    const r = fn(t.objectStore("files"));
    t.oncomplete = () => resolve(r.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
async function records(db: IDBDatabase): Promise<[string, FilesRecord][]> {
  const [keys, values] = await Promise.all([idb(db, "readonly", (s) => s.getAllKeys()), idb(db, "readonly", (s) => s.getAll())]);
  return keys.map((k, i) => [String(k), values[i] as FilesRecord]);
}
async function prune(db: IDBDatabase) {
  try {
    const old = Date.now() - FILES_MAX_AGE_MS;
    for (const [key, r] of await records(db)) if (!(r?.savedAt > old)) await idb(db, "readwrite", (s) => s.delete(key));
  } catch {}
}
async function loadFiles(c: Chat, storageKey: string) {
  const db = await openFilesDb();
  if (!db) return;
  try {
    const r = await idb<FilesRecord | undefined>(db, "readonly", (s) => s.get(storageKey));
    // Files added meanwhile, or another draft opened: leave it.
    if (!r?.files?.length || c.draftStorageKey !== storageKey || c.files.length) return;
    c.files = r.files.map((f) => ({ file: new File([f.data], f.name, { type: f.type, lastModified: f.lastModified }) }));
    written.set(c, c.files);
    filesChanged();
  } catch {}
}
async function writeFiles(storageKey: string, files: DraftFile[]) {
  const db = await openFilesDb();
  if (!db) return;
  try {
    if (!files.length) return void (await idb(db, "readwrite", (s) => s.delete(storageKey)));
    const bytes = files.reduce((n, f) => n + f.file.size, 0);
    const others = (await records(db)).filter(([k]) => k !== storageKey).sort((a, b) => b[1].savedAt - a[1].savedAt);
    if (bytes > FILES_BYTES) return void (await idb(db, "readwrite", (s) => s.delete(storageKey)));
    // The newest draft wins: older drafts' files make room for it.
    let total = bytes;
    for (const [key, r] of others) {
      total += r.bytes;
      if (total > FILES_BYTES) await idb(db, "readwrite", (s) => s.delete(key));
    }
    const stored = await Promise.all(files.map(async ({ file }) => ({ name: file.name, type: file.type, lastModified: file.lastModified, data: await file.arrayBuffer() })));
    const record: FilesRecord = { files: stored, bytes, savedAt: Date.now() };
    await idb(db, "readwrite", (s) => s.put(record, storageKey));
  } catch {}
}
export function restoreDraft(c: Chat, host: string, id: string) {
  const storageKey = `casm.draft:${JSON.stringify([host, id])}`;
  if (c.draftStorageKey === storageKey) return;
  c.draftStorageKey = storageKey;
  void loadFiles(c, storageKey);
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
    if (written.get(c) !== c.files && !(c.files.length === 0 && !written.has(c))) {
      written.set(c, c.files);
      void writeFiles(c.draftStorageKey!, c.files);
    }
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

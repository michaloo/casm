// IndexedDB for the saved copy: one key-value object store. IndexedDB needs no
// secure context, so plain-http deployments keep their copy too.
import { MemoryStore, OfflineCache, type Store } from "./offline-cache";

// The IndexedDB version only changes for object-store layout; the data schema
// inside is versioned and migrated by OfflineCache.
const NAME = "casm-offline";
const VERSION = 1;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IdbStore implements Store {
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const t = this.db.transaction("kv", mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
    const [result] = await Promise.all([request(fn(t.objectStore("kv"))), done]);
    return result;
  }
  get(key: string) { return this.tx("readonly", (s) => s.get(key)); }
  async put(key: string, value: unknown) { await this.tx("readwrite", (s) => s.put(value, key)); }
  async delete(key: string) { await this.tx("readwrite", (s) => s.delete(key)); }
  async clear() { await this.tx("readwrite", (s) => s.clear()); }
  async keys() { return (await this.tx("readonly", (s) => s.getAllKeys())).map(String); }
}

async function openStore(): Promise<Store> {
  if (!globalThis.indexedDB) return new MemoryStore();
  const open = indexedDB.open(NAME, VERSION);
  open.onupgradeneeded = (e) => {
    const db = open.result;
    // Version 1 is the first layout; later layouts add steps for e.oldVersion here.
    if (e.oldVersion < 1) db.createObjectStore("kv");
  };
  try {
    const db = await request(open);
    // Another tab upgrading the layout: let it, this one reopens on next load.
    db.onversionchange = () => db.close();
    return new IdbStore(db);
  } catch (error) {
    // Private browsing or a blocked database: keep working without a copy.
    console.warn("Offline copy unavailable", error);
    return new MemoryStore();
  }
}

let cache: Promise<OfflineCache> | undefined;
export function offlineCache(): Promise<OfflineCache> {
  return (cache ??= openStore().then((store) => new OfflineCache(store)));
}

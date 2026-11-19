// Browsers running the casm extension, and the tabs their users shared. The
// extension is an ordinary client: it authenticates with a client token, then
// calls browser.share with the tabs it shares, again after every change. Agent
// calls (browser.snapshot, browser.click…) become browser.command requests
// from this server to that connection, answered like any JSON-RPC request.
// Kept in memory only: a disconnected browser shares nothing, and a call for
// it fails at once instead of waiting for it to come back.
import {
  BROWSER_COMMAND_METHOD,
  BROWSER_FILE_MAX_BYTES,
  ErrorCode,
  type BrowserCommand,
  type BrowserDialog,
  type BrowserDownload,
  type BrowserTab,
  type Params,
  type SharedTab,
} from "@casm/protocol";
import { RpcError } from "./agents.ts";
import type { Conn } from "./methods.ts";

// Under the peer call timeout (15 s), so a forwarded call gets the browser's
// own error rather than "did not answer".
export const BROWSER_COMMAND_TIMEOUT_MS = 12_000;

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Browser = {
  conn: Conn;
  send: (raw: string) => void;
  browserId: string;
  label: string;
  connectedAt: string;
  tabs: Map<number, SharedTab>;
  // Set by its first browser.share.
  shared?: boolean;
  waiting: Map<string, Waiter>;
};
type Target = { browser: Browser; tabId: number };
type Which = { tab?: string; browser?: string };
// What the extension answers to a command on a tab, besides the command's own fields.
type Seen = { tabId?: number; url?: string; title?: string; dialog?: BrowserDialog; opened?: number[] };
type RawDownload = Omit<BrowserDownload, "id" | "tab"> & { tabId: number; n: number };

const notConnected = () => new RpcError(ErrorCode.Unreachable, "no browser is connected: open the casm extension and check its server settings");

export class BrowserHub {
  private browsers = new Map<Conn, Browser>();
  // "<browserId>\n<tabId>" ⇄ the short id agents use, for the server's lifetime.
  private ids = new Map<string, string>();
  private keys = new Map<string, { browserId: string; tabId: number }>();
  private nextId = 1;
  private nextRequest = 1;
  private timeoutMs: number;
  private log: (msg: string) => void;

  constructor(opts: { timeoutMs?: number; log?: (msg: string) => void } = {}) {
    this.timeoutMs = opts.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
  }

  share(conn: Conn, p: Params<"browser.share">) {
    if (!conn.send) throw new RpcError(ErrorCode.InvalidRequest, "browser.share needs a direct connection");
    let b = this.browsers.get(conn);
    if (!b) {
      // A reconnect of the same browser replaces its old connection.
      for (const other of this.browsers.values()) if (other.browserId === p.browserId) this.closed(other.conn, "the browser reconnected");
      b = { conn, send: conn.send, browserId: p.browserId, label: "", connectedAt: new Date().toISOString(), tabs: new Map(), waiting: new Map() };
      this.browsers.set(conn, b);
    }
    const wanted = p.label || conn.name || "browser";
    if (b.label !== wanted && !b.label.startsWith(`${wanted}-`)) {
      // Names must tell browsers apart: a second "chrome" becomes "chrome-2".
      const taken = new Set([...this.browsers.values()].filter((o) => o !== b).map((o) => o.label));
      let label = wanted;
      for (let n = 2; taken.has(label); n++) label = `${wanted}-${n}`;
      if (!b.label) this.log(`browser connected: ${label}`);
      b.label = label;
    }
    // The count, when it changes: what the server has, to hold against what the user sees.
    if (p.tabs.length !== b.tabs.size || !b.shared) this.log(`browser ${b.label}: ${p.tabs.length} shared tab${p.tabs.length === 1 ? "" : "s"}`);
    b.shared = true;
    b.tabs = new Map(p.tabs.map((t) => [t.tabId, t]));
    for (const t of p.tabs) this.idFor(b.browserId, t.tabId);
    return { ok: true as const };
  }

  // The connection closed: its tabs are gone and calls waiting on it fail now.
  closed(conn: Conn, reason = "the browser disconnected") {
    const b = this.browsers.get(conn);
    if (!b) return;
    this.browsers.delete(conn);
    for (const w of b.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new RpcError(ErrorCode.Unreachable, reason));
    }
    b.waiting.clear();
    this.log(`browser disconnected: ${b.label}`);
  }

  // A JSON-RPC response from a client: true when it answered one of our commands.
  response(conn: Conn, msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }): boolean {
    const b = this.browsers.get(conn);
    const w = typeof msg.id === "string" ? b?.waiting.get(msg.id) : undefined;
    if (!b || !w) return false;
    b.waiting.delete(msg.id as string);
    clearTimeout(w.timer);
    if (msg.error) w.reject(new RpcError(typeof msg.error.code === "number" ? msg.error.code : ErrorCode.Internal, `browser: ${msg.error.message ?? "failed"}`));
    else w.resolve(msg.result);
    return true;
  }

  list() {
    return [...this.browsers.values()].map((b) => ({ name: b.label, connectedAt: b.connectedAt, tabs: b.tabs.size }));
  }

  tabs(browser?: string) {
    const from = browser === undefined ? [...this.browsers.values()] : [this.named(browser)];
    const tabs = from.flatMap((b) => [...b.tabs.values()].map((t) => this.tab(b, t)));
    tabs.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
    return tabs;
  }

  // The browser a call means: named, the tab's, or the only one connected.
  browser(which: Which): Browser {
    if (!this.browsers.size) throw notConnected();
    if (which.tab !== undefined) return this.target(which).browser;
    if (which.browser !== undefined) return this.named(which.browser);
    if (this.browsers.size > 1)
      throw new RpcError(
        ErrorCode.InvalidParams,
        `${this.browsers.size} browsers are connected (${this.list().map((b) => b.name).join(", ")}): name one with --browser, or a tab with --tab`,
      );
    return [...this.browsers.values()][0];
  }

  // The shared tab a call acts on: `tab`, else the browser's most recently shared one.
  target(which: Which): Target {
    if (!this.browsers.size) throw notConnected();
    if (which.tab !== undefined) {
      const key = this.keys.get(which.tab);
      const browser = key && [...this.browsers.values()].find((b) => b.browserId === key.browserId && b.tabs.has(key.tabId));
      if (!key || !browser) throw new RpcError(ErrorCode.NotFound, `tab ${which.tab} is not shared${key ? " anymore" : ""} (casm browser tabs lists shared tabs)`);
      if (which.browser !== undefined && which.browser !== browser.label)
        throw new RpcError(ErrorCode.InvalidParams, `tab ${which.tab} is in ${browser.label}, not ${which.browser}`);
      return { browser, tabId: key.tabId };
    }
    const browser = this.browser(which);
    let latest: SharedTab | undefined;
    for (const t of browser.tabs.values()) if (!latest || t.sharedAt > latest.sharedAt) latest = t;
    if (!latest) throw new RpcError(ErrorCode.NotFound, `no tab is shared in ${browser.label}: share one from the casm extension (it joins the casm tab group)`);
    return { browser, tabId: latest.tabId };
  }

  // Sends one command and waits for the extension's answer, at most timeoutMs.
  command<T>(browser: Browser, cmd: BrowserCommand): Promise<T> {
    const id = `browser:${this.nextRequest++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.waiting.delete(id);
        reject(new RpcError(ErrorCode.Unreachable, `the browser did not answer ${cmd.action} within ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
      browser.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      browser.send(JSON.stringify({ jsonrpc: "2.0", id, method: BROWSER_COMMAND_METHOD, params: cmd }));
    });
  }

  // What every tab command returns: the tab after it (its title or url may
  // have changed), a dialog it left open, and tabs opened meanwhile.
  result(browser: Browser, tabId: number, seen: Seen) {
    const t = browser.tabs.get(tabId) ?? { tabId, title: "", url: "", sharedAt: new Date().toISOString() };
    const tab = this.tab(browser, { ...t, ...(seen.url ? { url: seen.url } : {}), ...(seen.title !== undefined ? { title: seen.title } : {}) });
    const opened = (seen.opened ?? []).flatMap((id) => (id !== tabId && browser.tabs.has(id) ? [this.tab(browser, browser.tabs.get(id)!)] : []));
    return { tab, ...(seen.dialog ? { dialog: seen.dialog } : {}), ...(opened.length ? { opened } : {}) };
  }

  // A command left a tab the browser never shared: logged, the server's side of a share that went missing.
  unshared(browser: Browser, tabId: number) {
    this.log(`browser ${browser.label}: answered with tab ${tabId}, which it hasn't shared (${browser.tabs.size} shared)`);
  }

  download(raw: RawDownload, browser: Browser): BrowserDownload {
    const { tabId, n, ...rest } = raw;
    const tab = this.idFor(browser.browserId, tabId);
    return { ...rest, id: `${tab}.${n}`, tab };
  }

  private named(name: string): Browser {
    const b = [...this.browsers.values()].find((x) => x.label === name);
    if (!b) throw new RpcError(ErrorCode.NotFound, `no browser named "${name}" is connected (connected: ${this.list().map((x) => x.name).join(", ") || "none"})`);
    return b;
  }

  private tab(b: Browser, t: SharedTab): BrowserTab {
    const opener = t.openerTabId === undefined ? undefined : this.ids.get(`${b.browserId}\n${t.openerTabId}`);
    return { id: this.idFor(b.browserId, t.tabId), browser: b.label, title: t.title, url: t.url, sharedAt: t.sharedAt, ...(opener ? { openedBy: opener } : {}) };
  }

  private idFor(browserId: string, tabId: number): string {
    const key = `${browserId}\n${tabId}`;
    let id = this.ids.get(key);
    if (!id) {
      id = String(this.nextId++);
      this.ids.set(key, id);
      this.keys.set(id, { browserId, tabId });
    }
    return id;
  }
}

// The agent-facing browser.* handlers.
export function browserHandlers(hub: BrowserHub) {
  const http = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RpcError(ErrorCode.InvalidParams, `not a URL: ${url} (give the full http:// or https:// URL)`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new RpcError(ErrorCode.InvalidParams, `only http and https URLs can be opened, not ${u.protocol}`);
    return u.href;
  };
  // "3.1": tab 3's first download.
  const downloadOf = (id: string) => {
    const m = id.match(/^(\d+)\.(\d+)$/);
    if (!m) throw new RpcError(ErrorCode.InvalidParams, `download ids look like 3.1 (tab 3, its first download), not ${id}`);
    return { ...hub.target({ tab: m[1] }), n: Number(m[2]) };
  };
  // One command on the target tab; `extra` picks the command's own fields from the answer.
  async function onTab<T extends Seen, X extends object>(which: Which, cmd: (tabId: number) => BrowserCommand, extra?: (r: T) => X) {
    const { browser, tabId } = hub.target(which);
    const r = await hub.command<T>(browser, cmd(tabId));
    return { ...hub.result(browser, tabId, r), ...(extra ? extra(r) : ({} as X)) };
  }
  return {
    "browser.list": () => ({ browsers: hub.list() }),
    "browser.tabs": (p: Params<"browser.tabs">) => ({ tabs: hub.tabs(p.browser), browsers: hub.list() }),
    "browser.share": (p: Params<"browser.share">, conn: Conn) => hub.share(conn, p),
    "browser.open": async (p: Params<"browser.open">) => {
      const url = http(p.url);
      const browser = hub.browser(p);
      const newTab = p.newTab || (p.tab === undefined && !browser.tabs.size);
      // A new tab goes next to the target tab (its window and casm group), when there is one.
      const target = browser.tabs.size ? hub.target(p).tabId : undefined;
      const cmd: BrowserCommand = newTab
        ? { action: "open", url, ...(target === undefined ? {} : { near: target }) }
        : { action: "open", url, tabId: target! };
      const r = await hub.command<Seen & { tabId: number }>(browser, cmd);
      // The extension shares a tab it opens before answering: one it didn't share has no id for agents.
      if (!browser.tabs.has(r.tabId)) {
        hub.unshared(browser, r.tabId);
        throw new RpcError(
          ErrorCode.Unreachable,
          `${browser.label} opened the page but didn't share the tab with this server: open the casm extension's popup to see why`,
        );
      }
      return hub.result(browser, r.tabId, r);
    },
    "browser.snapshot": (p: Params<"browser.snapshot">) => onTab(p, (tabId) => ({ action: "snapshot", tabId }), (r: Seen & { text: string }) => ({ text: r.text })),
    "browser.click": (p: Params<"browser.click">) => onTab(p, (tabId) => ({ action: "click", tabId, ref: p.ref, ...(p.newTab ? { newTab: true } : {}) })),
    "browser.type": (p: Params<"browser.type">) =>
      onTab(p, (tabId) => ({ action: "type", tabId, ref: p.ref, text: p.text, ...(p.submit ? { submit: true } : {}) })),
    "browser.press": (p: Params<"browser.press">) => onTab(p, (tabId) => ({ action: "press", tabId, key: p.key })),
    "browser.screenshot": (p: Params<"browser.screenshot">) =>
      onTab(p, (tabId) => ({ action: "screenshot", tabId }), (r: Seen & { data: string }) => ({ mediaType: "image/png", data: r.data })),
    "browser.eval": (p: Params<"browser.eval">) =>
      onTab(p, (tabId) => ({ action: "eval", tabId, expression: p.expression }), (r: Seen & { value?: unknown }) => ({ value: r.value ?? null })),
    "browser.dialog": (p: Params<"browser.dialog">) =>
      onTab(p, (tabId) => ({ action: "dialog", tabId, ...(p.response ? { response: p.response } : {}), ...(p.text !== undefined ? { text: p.text } : {}) })),
    "browser.upload": (p: Params<"browser.upload">) => {
      const bytes = p.files.reduce((n, f) => n + Buffer.byteLength(f.data, "base64"), 0);
      if (bytes > BROWSER_FILE_MAX_BYTES)
        throw new RpcError(ErrorCode.InvalidParams, `the files are ${bytes} bytes; uploads take at most ${BROWSER_FILE_MAX_BYTES} bytes in all`);
      return onTab(p, (tabId) => ({ action: "upload", tabId, ref: p.ref, files: p.files }));
    },
    "browser.downloads": async (p: Params<"browser.downloads">) => {
      if (!hub.list().length) throw notConnected();
      const browsers = p.browser === undefined ? hub.list().map((b) => hub.browser({ browser: b.name })) : [hub.browser({ browser: p.browser })];
      const lists = await Promise.all(
        browsers.map(async (b) => (await hub.command<{ downloads: RawDownload[] }>(b, { action: "downloads" })).downloads.map((d) => hub.download(d, b))),
      );
      return { downloads: lists.flat().sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
    },
    "browser.cancelDownload": async (p: Params<"browser.cancelDownload">) => {
      const { browser, tabId, n } = downloadOf(p.id);
      const r = await hub.command<{ download: RawDownload }>(browser, { action: "cancelDownload", tabId, n });
      return { download: hub.download(r.download, browser) };
    },
    "browser.download": async (p: Params<"browser.download">) => {
      const { browser, tabId, n } = downloadOf(p.id);
      const r = await hub.command<{ download: RawDownload; mimeType: string; data: string }>(browser, {
        action: "download",
        tabId,
        n,
        maxBytes: BROWSER_FILE_MAX_BYTES,
      });
      return { download: hub.download(r.download, browser), mimeType: r.mimeType, data: r.data };
    },
  };
}

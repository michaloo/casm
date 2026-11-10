// Browsers running the casm extension, and the tabs their users shared. The
// extension is an ordinary client: it authenticates with a client token, then
// calls browser.share with the tabs it shares, again after every change. Agent
// calls (browser.snapshot, browser.click…) become browser.command requests
// from this server to that connection, answered like any JSON-RPC request.
// Kept in memory only: a disconnected browser shares nothing, and a call for
// it fails at once instead of waiting for it to come back.
import { BROWSER_COMMAND_METHOD, ErrorCode, type BrowserCommand, type BrowserTab, type Params, type SharedTab } from "@casm/protocol";
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
  waiting: Map<string, Waiter>;
};

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
      this.log(`browser connected: ${p.label ?? conn.name}`);
    }
    b.label = p.label || conn.name || "browser";
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
    const tabs = [...this.browsers.values()].flatMap((b) => [...b.tabs.values()].map((t) => this.tab(b, t)));
    tabs.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
    return { tabs, browsers: [...this.browsers.values()].map((b) => ({ name: b.label, connectedAt: b.connectedAt })) };
  }

  // The shared tab `ref` names, else the most recently shared one.
  target(ref: string | undefined): { browser: Browser; tabId: number } {
    if (!this.browsers.size) throw new RpcError(ErrorCode.Unreachable, "no browser is connected: open the casm extension and check its server settings");
    if (ref !== undefined) {
      const key = this.keys.get(ref);
      const browser = key && [...this.browsers.values()].find((b) => b.browserId === key.browserId && b.tabs.has(key.tabId));
      if (!key || !browser) throw new RpcError(ErrorCode.NotFound, `tab ${ref} is not shared${key ? " anymore" : ""} (casm browser tabs lists shared tabs)`);
      return { browser, tabId: key.tabId };
    }
    let best: { browser: Browser; tab: SharedTab } | undefined;
    for (const browser of this.browsers.values())
      for (const tab of browser.tabs.values()) if (!best || tab.sharedAt > best.tab.sharedAt) best = { browser, tab };
    if (!best) throw new RpcError(ErrorCode.NotFound, "no tab is shared: share one from the casm extension (it joins the casm tab group)");
    return { browser: best.browser, tabId: best.tab.tabId };
  }

  // For browser.open with no tab to navigate: the browser that shared last, or the only one.
  anyBrowser(): Browser {
    const all = [...this.browsers.values()];
    if (!all.length) throw new RpcError(ErrorCode.Unreachable, "no browser is connected: open the casm extension and check its server settings");
    const latest = (b: Browser) => [...b.tabs.values()].reduce((m, t) => (t.sharedAt > m ? t.sharedAt : m), "");
    return all.reduce((a, b) => (latest(b) > latest(a) ? b : a));
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

  // The tab as agents see it, after a command (which may have changed its title or url).
  tabAfter(browser: Browser, tabId: number, seen?: { url?: string; title?: string }): BrowserTab {
    const t = browser.tabs.get(tabId) ?? { tabId, title: "", url: "", sharedAt: new Date().toISOString() };
    return this.tab(browser, { ...t, ...(seen?.url ? { url: seen.url } : {}), ...(seen?.title !== undefined ? { title: seen.title } : {}) });
  }

  private tab(b: Browser, t: SharedTab): BrowserTab {
    return { id: this.idFor(b.browserId, t.tabId), browser: b.label, title: t.title, url: t.url, sharedAt: t.sharedAt };
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
  type Seen = { url?: string; title?: string };
  return {
    "browser.tabs": () => hub.list(),
    "browser.share": (p: Params<"browser.share">, conn: Conn) => hub.share(conn, p),
    "browser.open": async (p: Params<"browser.open">) => {
      const url = http(p.url);
      const newTab = p.newTab || (p.tab === undefined && !hub.list().tabs.length);
      const { browser, tabId } = newTab ? { browser: hub.anyBrowser(), tabId: undefined } : hub.target(p.tab);
      const r = await hub.command<Seen & { tabId: number }>(browser, { action: "open", url, ...(tabId === undefined ? {} : { tabId }) });
      return { tab: hub.tabAfter(browser, r.tabId, r) };
    },
    "browser.snapshot": async (p: Params<"browser.snapshot">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen & { text: string }>(browser, { action: "snapshot", tabId });
      return { tab: hub.tabAfter(browser, tabId, r), text: r.text };
    },
    "browser.click": async (p: Params<"browser.click">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen>(browser, { action: "click", tabId, ref: p.ref });
      return { tab: hub.tabAfter(browser, tabId, r) };
    },
    "browser.type": async (p: Params<"browser.type">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen>(browser, { action: "type", tabId, ref: p.ref, text: p.text, ...(p.submit ? { submit: true } : {}) });
      return { tab: hub.tabAfter(browser, tabId, r) };
    },
    "browser.press": async (p: Params<"browser.press">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen>(browser, { action: "press", tabId, key: p.key });
      return { tab: hub.tabAfter(browser, tabId, r) };
    },
    "browser.screenshot": async (p: Params<"browser.screenshot">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen & { data: string }>(browser, { action: "screenshot", tabId });
      return { tab: hub.tabAfter(browser, tabId, r), mediaType: "image/png", data: r.data };
    },
    "browser.eval": async (p: Params<"browser.eval">) => {
      const { browser, tabId } = hub.target(p.tab);
      const r = await hub.command<Seen & { value?: unknown }>(browser, { action: "eval", tabId, expression: p.expression });
      return { tab: hub.tabAfter(browser, tabId, r), value: r.value ?? null };
    },
  };
}

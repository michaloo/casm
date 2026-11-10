// The casm extension's service worker: a casm client that shares tabs.
//
// Sharing is a tab group: our "casm" groups (one per window) hold exactly the
// shared tabs. Sharing a tab moves it into the group; taking it out of the
// group, closing it or the group, or the popup's Stop button unshares it. The
// group ids live in chrome.storage.session, so a browser restart (which may
// restore a group titled "casm") shares nothing.
//
// Tabs a shared tab opens (window.open, target=_blank, OAuth popups) are
// shared too, deliberately: flows like "sign in with…" continue in them. A
// tab in a popup window, which Chrome may refuse to group, is tracked as a
// "loose" share instead, and ends with its window.
//
// The debugger attaches to a shared tab when an agent command arrives and
// detaches IDLE_DETACH_MS after the last one, unless a command is still
// running, a dialog is waiting for the agent or a download is in progress.
// So Chrome's "started debugging this browser" bar shows while agents work.
// Cancel on that bar detaches only; the tabs stay shared and the next command
// attaches again. Every agent command checks again that its tab is shared
// before touching it: the server's list is not trusted.
//
// The WebSocket to the casm server keeps this worker alive while connected
// (a request every 20 s), an alarm wakes it to reconnect after it was
// stopped, and lost connections retry with backoff.
import * as act from "./actions.js";

const GROUP_TITLE = "casm";
const GROUP_COLOR = "orange";
const PING_MS = 20_000;
const CALL_TIMEOUT_MS = 10_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const NEW_TAB_LOAD_MS = 10_000;
let IDLE_DETACH_MS = 30_000;

const conn = {
  ws: null,
  // idle | unconfigured | connecting | connected | disconnected | refused
  status: "idle",
  detail: "",
  retryMs: RETRY_MIN_MS,
  retryTimer: undefined,
  pingTimer: undefined,
  nextId: 1,
  waiting: new Map(),
};
const attached = new Set();
// Per tab: commands running, and the idle timer that detaches the debugger.
const inFlight = new Map();
const idleTimers = new Map();

// ---------------------------------------------------------------------------
// Settings

async function settings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return settings;
}

async function browserId() {
  let { browserId } = await chrome.storage.local.get("browserId");
  if (!browserId) {
    browserId = crypto.randomUUID();
    await chrome.storage.local.set({ browserId });
  }
  return browserId;
}

// The default name agents see: "chrome", "chromium" (ungoogled Chromium says
// Chromium too), "edge", "brave"…; the server makes it unique.
function defaultLabel() {
  const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
  const known = [["Google Chrome", "chrome"], ["Microsoft Edge", "edge"], ["Brave", "brave"], ["Opera", "opera"], ["Vivaldi", "vivaldi"], ["Chromium", "chromium"]];
  return known.find(([brand]) => brands.includes(brand))?.[1] ?? "chromium";
}

async function saveSettings({ url, token, label }) {
  url = String(url ?? "").trim();
  if (!/^wss?:\/\/[^/]+/.test(url)) throw new Error("the server URL starts with ws:// or wss://, e.g. ws://my-server:7373");
  const current = await settings();
  const next = { url, label: String(label ?? "").trim(), token: String(token ?? "").trim() || current.token || "" };
  if (!next.token) throw new Error("paste a client token (casm token create <name> on the server)");
  await chrome.storage.local.set({ settings: next });
  reconnect();
}

// ---------------------------------------------------------------------------
// Sharing

async function ourGroups() {
  const { groups = [] } = await chrome.storage.session.get("groups");
  return groups;
}

async function sharedTabs() {
  const groups = await ourGroups();
  const { loose = [] } = await chrome.storage.session.get("loose");
  const grouped = (await Promise.all(groups.map((groupId) => chrome.tabs.query({ groupId }).catch(() => [])))).flat();
  const others = (await Promise.all(loose.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t && !grouped.some((g) => g.id === t.id));
  return [...grouped, ...others];
}

async function isShared(tabId) {
  return (await sharedTabs()).some((t) => t.id === tabId);
}

// Changes to the groups and syncs run one at a time: a sync reads and writes
// the stored group ids, and must not overwrite a group a share just made.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const shareTab = (tabId, opts) => serial(() => shareNow(tabId, opts));

async function shareNow(tabId, { anyUrl = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.pendingUrl || tab.url || "";
  if (!anyUrl && !/^https?:\/\//.test(url)) throw new Error("only http and https pages can be shared");
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== "normal") {
    try {
      await groupInto(tab);
    } catch {
      // Chrome groups tabs of normal windows only (some versions); track this one by id.
      const { loose = [] } = await chrome.storage.session.get("loose");
      await chrome.storage.session.set({ loose: [...new Set([...loose, tabId])] });
    }
  } else await groupInto(tab);
  await syncNow();
}

// Puts the tab into our group in its window, making the group if needed.
async function groupInto(tab) {
  const tabId = tab.id;
  const groups = await ourGroups();
  let groupId;
  for (const g of groups) {
    const info = await chrome.tabGroups.get(g).catch(() => null);
    if (info?.windowId === tab.windowId) groupId = g;
  }
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.storage.session.set({ groups: [...groups, groupId] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  } else {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  }
}

async function dropLoose(ids) {
  const { loose = [] } = await chrome.storage.session.get("loose");
  await chrome.storage.session.set({ loose: loose.filter((id) => !ids.includes(id)) });
}

const unshareTab = (tabId) =>
  serial(async () => {
    await dropLoose([tabId]);
    if (await isShared(tabId)) await chrome.tabs.ungroup(tabId).catch(() => {});
    await syncNow();
  });

const unshareAll = () =>
  serial(async () => {
    const tabs = await sharedTabs();
    await chrome.storage.session.set({ loose: [] });
    for (const t of tabs) if (t.groupId !== -1) await chrome.tabs.ungroup(t.id).catch(() => {});
    await syncNow();
  });

async function attach(tabId) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw e;
    }
    attached.add(tabId);
  }
  // From now on dialogs, downloads and iframes of the tab are tracked.
  await act.setup(tabId);
}

// `forget`: the tab is no longer shared, so its refs and downloads go too.
async function detach(tabId, { forget = false } = {}) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  const was = attached.delete(tabId);
  if (forget) act.forgetTab(tabId);
  else act.detached(tabId);
  if (was) await chrome.debugger.detach({ tabId }).catch(() => {});
}

// Detach once agents have left the tab alone for a while.
function idleLater(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.set(
    tabId,
    setTimeout(() => {
      if (inFlight.get(tabId) || act.keepAttached(tabId)) return idleLater(tabId);
      void detach(tabId);
    }, IDLE_DETACH_MS),
  );
}

// Reconciles everything with the groups as they are now: which tabs are
// shared and since when, the debugger, the badge and the server.
const sync = () => serial(syncNow);

async function syncNow() {
  const live = [];
  for (const g of await ourGroups()) if (await chrome.tabGroups.get(g).catch(() => null)) live.push(g);
  await chrome.storage.session.set({ groups: live });
  const tabs = await sharedTabs();
  const { sharedAt: before = {} } = await chrome.storage.session.get("sharedAt");
  const sharedAt = {};
  for (const t of tabs) sharedAt[t.id] = before[t.id] ?? new Date().toISOString();
  await chrome.storage.session.set({ sharedAt });
  for (const id of new Set([...Object.keys(before).map(Number), ...attached])) if (!(id in sharedAt)) await detach(id, { forget: true });
  await dropLoose(Object.keys(before).map(Number).filter((id) => !(id in sharedAt)));
  await chrome.action.setBadgeText({ text: tabs.length ? String(tabs.length) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: conn.status === "connected" ? "#d9730d" : "#888888" });
  await publish(tabs, sharedAt);
  changed();
}

async function publish(tabs, sharedAt) {
  if (conn.status !== "connected") return;
  const s = await settings();
  const ids = new Set(tabs.map((t) => t.id));
  const { openers = {} } = await chrome.storage.session.get("openers");
  const shared = tabs.map((t) => ({
    tabId: t.id,
    title: t.title ?? "",
    url: t.pendingUrl || t.url || "",
    sharedAt: sharedAt[t.id],
    // Only a shared opener: other tabs' ids are none of the server's business.
    ...(ids.has(openers[t.id] ?? t.openerTabId) ? { openerTabId: openers[t.id] ?? t.openerTabId } : {}),
  }));
  // Sent now, before any answer this sync precedes; the reply doesn't matter.
  call("browser.share", { browserId: await browserId(), label: s.label || defaultLabel(), tabs: shared }).catch((e) => console.warn(`casm: share failed: ${e.message}`));
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status === "loading") act.forgetRefs(tabId);
  if ("groupId" in change) return void sync();
  // Other tabs' titles and URLs are none of the server's business.
  if (("url" in change || "title" in change) && (await ourGroups()).includes(tab.groupId)) void sync();
});
chrome.tabs.onRemoved.addListener(() => void sync());
// A tab a shared tab opens is shared too, and reported with the next answer.
const opened = [];
chrome.tabs.onCreated.addListener(async (tab) => {
  const opener = await openerOf(tab);
  if (opener === undefined) return;
  try {
    const { openers = {} } = await chrome.storage.session.get("openers");
    await chrome.storage.session.set({ openers: { ...openers, [tab.id]: opener } });
    await shareTab(tab.id, { anyUrl: true });
    opened.push(tab.id);
  } catch (e) {
    console.warn(`casm: can't share the tab ${opener} opened: ${e.message}`);
  }
});

// The shared tab that opened `tab`, if one did: by the source's Page.windowOpen
// (its URL can take a moment to show), else Chrome's openerTabId (right for
// the user's own clicks, which happen in the front tab).
async function openerOf(tab) {
  for (let i = 0; i < 10; i++) {
    const url = tab.pendingUrl || tab.url;
    const from = url && act.openedFrom(url);
    if (from !== undefined && (await isShared(from))) return from;
    if (url && url !== "about:blank") break;
    await new Promise((r) => setTimeout(r, 50));
    tab = await chrome.tabs.get(tab.id).catch(() => tab);
  }
  return tab.openerTabId !== undefined && (await isShared(tab.openerTabId)) ? tab.openerTabId : undefined;
}
chrome.debugger.onEvent.addListener((source, method, params) => act.onEvent(source, method, params));
chrome.tabs.onAttached.addListener(() => void sync());
chrome.tabGroups.onRemoved.addListener(() => void sync());
chrome.debugger.onDetach.addListener(({ tabId }) => {
  // Cancel on Chrome's debugging bar, the tab closing, DevTools taking over:
  // the session is gone, the sharing isn't. The next command attaches again.
  clearTimeout(idleTimers.get(tabId));
  attached.delete(tabId);
  act.detached(tabId);
  void sync();
});

// ---------------------------------------------------------------------------
// Agent commands (browser.command from the server)

async function command(p) {
  if (p.action === "downloads") return { downloads: (await sharedTabs()).flatMap((t) => act.downloads(t.id)) };
  let r;
  if (p.action === "open" && p.tabId === undefined) {
    // Next to a tab only if that one is shared: the server doesn't pick windows.
    const near = p.near !== undefined && (await isShared(p.near)) ? p.near : undefined;
    r = await openTab(p.url, near);
    if (!opened.includes(r.tabId)) opened.push(r.tabId);
  }
  else {
    // Checked here, against the groups, whatever the server thinks is shared.
    if (!(await isShared(p.tabId))) throw new act.ActionError("that tab is not shared anymore");
    const t = p.tabId;
    inFlight.set(t, (inFlight.get(t) ?? 0) + 1);
    try {
      const run = {
        open: () => act.navigate(t, p.url),
        snapshot: () => act.snapshot(t),
        click: async () => {
          const before = opened.length;
          const r = await act.click(t, p.ref, p.newTab);
          // A new tab may take a moment to be created and shared.
          for (let i = 0; p.newTab && opened.length === before && i < 15; i++) await new Promise((w) => setTimeout(w, 100));
          return r;
        },
        type: () => act.type(t, p.ref, p.text, p.submit),
        press: () => act.press(t, p.key),
        screenshot: () => act.screenshot(t),
        eval: () => act.evaluate(t, p.expression),
        upload: () => act.upload(t, p.ref, p.files ?? []),
        download: () => act.fetchDownload(t, p.n, p.maxBytes),
      }[p.action];
      if (!run && p.action !== "dialog") throw new act.ActionError(`unknown action ${p.action}`, -32601);
      await attach(t);
      if (p.action === "dialog") r = await act.dialog(t, p.response, p.text);
      else r = await act.guarded(t, run);
      r = { ...r, tabId: t };
    } finally {
      inFlight.set(t, inFlight.get(t) - 1);
      idleLater(t);
    }
  }
  // Shares of tabs it opened go out before this answer, so the server knows them.
  await serial(() => {});
  const tab = await chrome.tabs.get(r.tabId).catch(() => null);
  const dialog = act.openDialog(r.tabId);
  return {
    ...r,
    ...(tab ? { url: tab.url ?? "", title: tab.title ?? "" } : {}),
    ...(dialog ? { dialog } : {}),
    ...(opened.length ? { opened: opened.splice(0) } : {}),
  };
}

// A new tab in the casm group of `near`'s window, right after it (else of the
// window that shared last, or the current one), with `near` as its opener.
async function openTab(url, near) {
  const tabs = await sharedTabs();
  const { sharedAt = {} } = await chrome.storage.session.get("sharedAt");
  const latest = tabs.sort((a, b) => String(sharedAt[b.id]).localeCompare(String(sharedAt[a.id])))[0];
  let anchor = near === undefined ? latest : tabs.find((t) => t.id === near);
  // A popup window can't hold more tabs: open next to its opener instead.
  if (anchor && (await chrome.windows.get(anchor.windowId).catch(() => null))?.type !== "normal")
    anchor = tabs.find((t) => t.id === anchor.openerTabId) ?? undefined;
  const windowId = anchor?.windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  // In the background: casm never brings a tab to the front.
  const tab = await chrome.tabs.create({
    url,
    active: false,
    ...(windowId === undefined ? {} : { windowId }),
    ...(anchor ? { index: anchor.index + 1, openerTabId: anchor.id } : {}),
  });
  await shareTab(tab.id, { anyUrl: true });
  const until = Date.now() + NEW_TAB_LOAD_MS;
  let now = tab;
  do {
    await new Promise((r) => setTimeout(r, 100));
    now = await chrome.tabs.get(tab.id);
  } while (now.status !== "complete" && Date.now() < until);
  return { tabId: tab.id, url: now.url ?? url, title: now.title ?? "" };
}

// ---------------------------------------------------------------------------
// The connection

function call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const ws = conn.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.waiting.delete(id);
      reject(new Error(`${method}: no answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    conn.waiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function setStatus(status, detail = "") {
  conn.status = status;
  conn.detail = detail;
  void chrome.action.setBadgeBackgroundColor({ color: status === "connected" ? "#d9730d" : "#888888" });
  changed();
}

async function connect() {
  clearTimeout(conn.retryTimer);
  if (conn.ws || conn.status === "refused") return;
  const s = await settings();
  if (!s.url || !s.token) return setStatus("unconfigured", "set the casm server URL and a client token");
  setStatus("connecting", s.url);
  let ws;
  try {
    ws = new WebSocket(s.url);
  } catch (e) {
    setStatus("disconnected", e.message);
    return retryLater();
  }
  conn.ws = ws;
  ws.onopen = async () => {
    try {
      // Browsers can't send a header on a WebSocket: the token goes in the first request.
      await call("auth", { token: s.token });
    } catch {
      return;
    }
    conn.retryMs = RETRY_MIN_MS;
    setStatus("connected", s.url);
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => call("server.info", {}).catch(() => lost(ws, "the server stopped answering")), PING_MS);
    await sync();
  };
  ws.onmessage = (ev) => void onMessage(ws, ev.data);
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      lost(ws, "the server refused the token");
      setStatus("refused", "the server refused the token: create one with casm token create <name> and save it here");
    } else lost(ws, ev.reason || `the connection closed (${ev.code})`);
  };
}

// Drops `ws` (if it is still ours) and fails everything waiting on it.
function lost(ws, why) {
  if (conn.ws !== ws) return;
  conn.ws = null;
  clearInterval(conn.pingTimer);
  for (const w of conn.waiting.values()) {
    clearTimeout(w.timer);
    w.reject(new Error(why));
  }
  conn.waiting.clear();
  try {
    ws.close();
  } catch {}
  setStatus("disconnected", why);
  retryLater();
}

function retryLater() {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = setTimeout(connect, conn.retryMs);
  conn.retryMs = Math.min(conn.retryMs * 2, RETRY_MAX_MS);
}

function reconnect() {
  const ws = conn.ws;
  conn.ws = null;
  conn.status = "idle";
  conn.retryMs = RETRY_MIN_MS;
  ws?.close();
  void connect();
}

async function onMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.method === "browser.command" && msg.id !== undefined) {
    let reply;
    try {
      reply = { jsonrpc: "2.0", id: msg.id, result: await command(msg.params ?? {}) };
    } catch (e) {
      reply = { jsonrpc: "2.0", id: msg.id, error: { code: typeof e.code === "number" ? e.code : -32603, message: e.message ?? String(e) } };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    return;
  }
  const w = conn.waiting.get(msg.id);
  if (!w) return;
  conn.waiting.delete(msg.id);
  clearTimeout(w.timer);
  if (msg.error) w.reject(new Error(msg.error.message));
  else w.resolve(msg.result);
}

// ---------------------------------------------------------------------------
// Popup, context menu, lifecycle

async function state() {
  const s = await settings();
  const tabs = await sharedTabs();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return {
    status: conn.status,
    detail: conn.detail,
    settings: { url: s.url ?? "", label: s.label ?? "", hasToken: !!s.token, defaultLabel: defaultLabel() },
    shared: tabs.map((t) => ({ id: t.id, title: t.title ?? "", url: t.url ?? "" })),
    current: current ? { id: current.id, url: current.url ?? "", shared: tabs.some((t) => t.id === current.id) } : null,
  };
}

function changed() {
  chrome.runtime.sendMessage({ type: "changed" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const run = {
    state: () => state(),
    share: () => shareTab(msg.tabId),
    unshare: () => unshareTab(msg.tabId),
    unshareAll: () => unshareAll(),
    save: () => saveSettings(msg),
    reconnect: () => reconnect(),
  }[msg.type];
  if (!run) return false;
  Promise.resolve()
    .then(run)
    .then((r) => respond({ ok: true, ...(r ?? {}) }), (e) => respond({ ok: false, error: e.message }));
  return true;
});

const MENU = "casm-toggle";
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: "Share this tab with casm agents, or stop", contexts: ["page", "action"] });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU || !tab?.id) return;
  try {
    if (await isShared(tab.id)) await unshareTab(tab.id);
    else await shareTab(tab.id);
  } catch (e) {
    console.warn(`casm: ${e.message}`);
  }
});

chrome.alarms.create("casm-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());

// For debugging from the service worker console (and the end-to-end check).
globalThis.casm = {
  share: shareTab, unshare: unshareTab, unshareAll, sync, reconnect, state, saveSettings, command,
  attached: () => [...attached],
  setIdleDetachMs: (ms) => (IDLE_DETACH_MS = ms),
};

void connect();
void sync();

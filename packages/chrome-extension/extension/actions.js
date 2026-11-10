// What agents do in a shared tab, over chrome.debugger (the Chrome DevTools
// Protocol). The caller (background.js) has already checked the tab is shared
// and attached the debugger.
//
// The debugger is attached only while agents work (background.js detaches
// it when they stop), so what must outlive a detach lives in the tab's state:
// refs (backend node ids stay valid across sessions), the downloads, and the
// frame each belongs to, by target id rather than by session.
//
// Frames: same-process iframes share the tab's own session; cross-origin
// ones (out-of-process) get a session each through Target.setAutoAttach.
// A ref remembers its frame, and clicks add up the iframes' offsets.
//
// Dialogs block the page (Runtime.evaluate waits until they close), so each
// command races against a dialog opening, and while one is open every command
// but `dialog` fails at once. Nothing answers a dialog except the agent or the
// user. One that opens while detached is shown to the user by Chrome and can't
// be seen from a new session; the page then doesn't answer, which setup
// reports after SETUP_WAIT_MS.
import { formatAXTree } from "./snapshot.js";
import { keyEvents } from "./keys.js";

// An error the server passes on with this JSON-RPC code (1001 NotFound, 1002 Busy).
export class ActionError extends Error {
  constructor(message, code = 1001) {
    super(message);
    this.code = code;
  }
}

const LOAD_WAIT_MS = 10_000;
const SCREENSHOT_WAIT_MS = 8_000;
const SETUP_WAIT_MS = 2_000;
// After a click or a key, how long a dialog or a popup it caused has to show up in the answer.
const SETTLE_MS = 250;

const cdp = (tabId, method, params = {}, sessionId) => chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per shared tab, in memory: for the current attach, its setup and child
// sessions (sessionId → {targetId, parent}); kept across attaches, the last
// snapshot's refs and the downloads. `dialog` is open while attached (it
// keeps the debugger attached).
const tabs = new Map();
function state(tabId) {
  let s = tabs.get(tabId);
  if (!s) tabs.set(tabId, (s = { ready: null, sessions: new Map(), refs: {}, dialog: null, dialogWaiters: new Set(), downloads: [], nextDownload: 1 }));
  return s;
}

// The tab is no longer shared: everything goes.
export function forgetTab(tabId) {
  tabs.delete(tabId);
}

// The debugger let go of the tab (idle, or the user's Cancel): sessions are
// gone, refs and downloads stay. A dialog still open is now the user's.
export function detached(tabId) {
  const s = tabs.get(tabId);
  if (!s) return;
  s.ready = null;
  s.sessions.clear();
  s.dialog = null;
}

// What keeps the debugger attached between commands: an open dialog (only
// this session can answer it) or a download still running (its progress).
export function keepAttached(tabId) {
  const s = tabs.get(tabId);
  return !!s && (!!s.dialog || s.downloads.some((d) => d.state === "inProgress"));
}

export function forgetRefs(tabId) {
  const s = tabs.get(tabId);
  if (s) s.refs = {};
}

// Domains and auto-attach to out-of-process iframes, once per attach.
export function setup(tabId) {
  const s = state(tabId);
  s.ready ??= Promise.race([
    initSession(tabId, undefined),
    sleep(SETUP_WAIT_MS).then(() => {
      throw new ActionError(
        "the page does not respond: a dialog is probably open in the browser (it opened while no agent was working, so it is the user's): ask the user to answer it, then try again",
        1002,
      );
    }),
  ]).catch((e) => {
    s.ready = null;
    throw e;
  });
  return s.ready;
}

async function initSession(tabId, sessionId) {
  await cdp(tabId, "Page.enable", {}, sessionId);
  await cdp(tabId, "DOM.enable", {}, sessionId);
  // Off and on again, so frames attached before a service worker restart are announced again.
  await cdp(tabId, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await cdp(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
}

// chrome.debugger.onEvent, for every tab.
export function onEvent(source, method, params) {
  const s = tabs.get(source.tabId);
  if (!s) return;
  const from = source.sessionId;
  switch (method) {
    case "Target.attachedToTarget":
      if (params.targetInfo?.type === "iframe") {
        s.sessions.set(params.sessionId, { targetId: params.targetInfo.targetId, parent: from });
        initSession(source.tabId, params.sessionId).catch(() => {});
      }
      break;
    case "Target.detachedFromTarget":
      s.sessions.delete(params.sessionId);
      break;
    case "Page.javascriptDialogOpening":
      s.dialog = {
        session: from,
        type: params.type,
        message: params.message ?? "",
        ...(params.type === "prompt" ? { defaultPrompt: params.defaultPrompt ?? "" } : {}),
        url: params.url,
      };
      for (const wake of s.dialogWaiters) wake();
      break;
    case "Page.javascriptDialogClosed":
      if (s.dialog?.session === from) s.dialog = null;
      break;
    case "Page.frameRequestedNavigation":
      // A modified or middle click: the navigation goes to a new tab or window.
      if (params.disposition !== "newTab" && params.disposition !== "newWindow") break;
    // falls through
    case "Page.windowOpen":
      windowOpens.push({ tabId: source.tabId, url: normal(params.url), at: Date.now() });
      while (windowOpens.length && Date.now() - windowOpens[0].at > WINDOW_OPEN_MS) windowOpens.shift();
      break;
    case "Page.downloadWillBegin":
      s.downloads.push({ n: s.nextDownload++, guid: params.guid, frame: frameOf(s, from), url: params.url, filename: params.suggestedFilename ?? "", state: "inProgress", startedAt: new Date().toISOString() });
      break;
    case "Page.downloadProgress": {
      const d = s.downloads.find((x) => x.guid === params.guid);
      if (d) Object.assign(d, { state: params.state, receivedBytes: params.receivedBytes, ...(params.totalBytes ? { totalBytes: params.totalBytes } : {}) });
      break;
    }
  }
}

// A frame key that outlives sessions: the out-of-process frame's target id, or undefined for the tab's own.
function frameOf(s, sessionId) {
  return sessionId === undefined ? undefined : s.sessions.get(sessionId)?.targetId;
}

// The current session for a frame key, waiting briefly for a re-attach to announce it.
async function sessionOf(tabId, frame) {
  if (frame === undefined) return undefined;
  const s = state(tabId);
  for (let i = 0; i < 20; i++) {
    for (const [sessionId, info] of s.sessions) if (info.targetId === frame) return sessionId;
    await sleep(50);
  }
  throw new ActionError("that frame is gone: take a new snapshot");
}

// Which tab opened a new one. Chrome's openerTabId is the window's active tab
// for links opened in the background (a Control- or middle-click), so the
// source tab's own events are asked first: Page.windowOpen (window.open,
// target=_blank) and Page.frameRequestedNavigation into a new tab (modified
// and middle clicks). Only seen while the debugger is attached.
const WINDOW_OPEN_MS = 5_000;
const windowOpens = [];
const normal = (url) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};
export function openedFrom(url) {
  const i = windowOpens.findIndex((w) => w.url === normal(url) && Date.now() - w.at < WINDOW_OPEN_MS);
  return i < 0 ? undefined : windowOpens.splice(i, 1)[0].tabId;
}

export function openDialog(tabId) {
  const d = tabs.get(tabId)?.dialog;
  if (!d) return undefined;
  const { session: _, ...dialog } = d;
  return dialog;
}

// Runs one command, unless a dialog is open; returns early with `dialog` when one opens meanwhile.
export async function guarded(tabId, run) {
  const s = state(tabId);
  const open = openDialog(tabId);
  if (open)
    throw new ActionError(`a ${open.type} dialog is open: ${JSON.stringify(open.message)}. Answer it first: casm browser dialog accept|dismiss`, 1002);
  let wake;
  const opened = new Promise((r) => s.dialogWaiters.add((wake = r)));
  try {
    const r = await Promise.race([run(), opened.then(() => ({}))]);
    return r;
  } finally {
    s.dialogWaiters.delete(wake);
  }
}

// ---------------------------------------------------------------------------
// Snapshot, with iframes

// Every frame of the tab: [{session, frameId, owner: {session, node}?}].
async function frames(tabId) {
  const s = state(tabId);
  const out = [];
  const walk = (tree, session, root) => {
    out.push({ session, frameId: tree.frame.id, root });
    for (const child of tree.childFrames ?? []) walk(child, session, false);
  };
  for (const session of [undefined, ...s.sessions.keys()]) {
    try {
      walk((await cdp(tabId, "Page.getFrameTree", {}, session)).frameTree, session, true);
    } catch {
      // A frame that went away meanwhile.
    }
  }
  for (const f of out) {
    if (f.session === undefined && f.root) continue;
    // A same-process frame's owner is in its own session; a child session's root's, in the parent's.
    const ownerSession = f.root ? s.sessions.get(f.session)?.parent : f.session;
    try {
      const { backendNodeId } = await cdp(tabId, "DOM.getFrameOwner", { frameId: f.frameId }, ownerSession);
      f.owner = { session: ownerSession, node: backendNodeId };
      if (f.root) s.sessions.get(f.session).owner = backendNodeId;
    } catch {}
  }
  return out;
}

export async function snapshot(tabId) {
  await setup(tabId);
  const all = [];
  const list = await frames(tabId);
  const trees = [];
  for (const [i, f] of list.entries()) {
    let nodes;
    try {
      ({ nodes } = await cdp(tabId, "Accessibility.getFullAXTree", { frameId: f.frameId }, f.session));
    } catch {
      continue;
    }
    // Node ids are per frame: prefix them, and remember each node's session.
    const mine = nodes.map((n) => ({
      ...n,
      nodeId: `${i}:${n.nodeId}`,
      parentId: n.parentId === undefined ? undefined : `${i}:${n.parentId}`,
      childIds: (n.childIds ?? []).map((c) => `${i}:${c}`),
      session: frameOf(state(tabId), f.session),
      sessionId: f.session,
    }));
    trees.push({ frame: f, nodes: mine });
    all.push(...mine);
  }
  // Each frame's document goes under its <iframe> element in the parent.
  for (const { frame, nodes } of trees) {
    if (!frame.owner) continue;
    const owner = all.find((n) => n.sessionId === frame.owner.session && n.backendDOMNodeId === frame.owner.node);
    if (!owner) continue;
    for (const root of nodes.filter((n) => n.parentId === undefined)) {
      root.parentId = owner.nodeId;
      owner.childIds.push(root.nodeId);
    }
  }
  const out = formatAXTree(all);
  state(tabId).refs = out.refs;
  return { text: out.text };
}

function node(tabId, ref) {
  const r = tabs.get(tabId)?.refs[ref];
  if (!r) throw new ActionError(`unknown ref ${ref}: take a new snapshot (refs last until the next snapshot or navigation)`);
  return r;
}

// CDP's "No node with given id" means the page changed under the ref.
async function onNode(tabId, ref, fn) {
  const { node: backendNodeId, session: frame } = node(tabId, ref);
  const session = await sessionOf(tabId, frame);
  try {
    return await fn(backendNodeId, session);
  } catch (e) {
    if (!(e instanceof ActionError) && /node|object|session|target/i.test(String(e?.message))) throw new ActionError(`ref ${ref} is stale (${e.message}): take a new snapshot`);
    throw e;
  }
}

// The <iframe> elements between the page and `session`, outermost first.
async function owners(tabId, session) {
  const s = state(tabId);
  const chain = [];
  while (session !== undefined) {
    const info = s.sessions.get(session);
    if (!info) throw new ActionError("the frame is gone: take a new snapshot");
    if (info.owner === undefined) info.owner = (await cdp(tabId, "DOM.getFrameOwner", { frameId: info.targetId }, info.parent)).backendNodeId;
    chain.unshift({ session: info.parent, node: info.owner });
    session = info.parent;
  }
  return chain;
}

// The node's centre in the tab's viewport: an out-of-process frame reports
// boxes in its own viewport, so each <iframe>'s content box is added.
async function centre(tabId, backendNodeId, session) {
  const chain = await owners(tabId, session);
  for (const o of chain) await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: o.node }, o.session);
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, session);
  let dx = 0;
  let dy = 0;
  for (const o of chain) {
    const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: o.node }, o.session);
    // Same-process frames above report page coordinates already; only cross-session steps add up.
    dx += model.content[0];
    dy += model.content[1];
  }
  const { quads } = await cdp(tabId, "DOM.getContentQuads", { backendNodeId }, session);
  const q = quads?.[0];
  if (!q) return null;
  return { x: dx + (q[0] + q[2] + q[4] + q[6]) / 4, y: dy + (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// ---------------------------------------------------------------------------
// Commands

async function waitForLoad(tabId) {
  const until = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < until) {
    await sleep(100);
    if (openDialog(tabId)) return;
    try {
      const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (result?.value === "complete") return;
    } catch {
      // The old document is going away mid-navigation; ask again.
    }
  }
}

export async function navigate(tabId, url) {
  forgetRefs(tabId);
  const r = await cdp(tabId, "Page.navigate", { url });
  if (r.errorText) throw new ActionError(`could not open ${url}: ${r.errorText}`, -32603);
  await waitForLoad(tabId);
  return {};
}

// `newTab`: with the modifier that opens a link in a new tab (Command on macOS, Control elsewhere).
export async function click(tabId, ref, newTab = false) {
  const mac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
  const modifiers = newTab ? (mac ? 4 : 2) : 0;
  await onNode(tabId, ref, async (backendNodeId, session) => {
    const p = await centre(tabId, backendNodeId, session);
    if (!p) throw new ActionError(`${ref} has no visible box to click`);
    // Input goes to the tab's own session, which routes it into the frame under the point.
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...p, modifiers });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1, modifiers });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1, modifiers });
  });
  await sleep(SETTLE_MS);
  return {};
}

export async function type(tabId, ref, text, submit) {
  await onNode(tabId, ref, async (backendNodeId, session) => {
    await cdp(tabId, "DOM.focus", { backendNodeId }, session);
    // Select what's there, so the text replaces it, as typing over a selection does.
    const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId }, session);
    await cdp(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function () {
          if (typeof this.select === "function" && "value" in this) this.select();
          else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        }`,
      },
      session,
    );
    // Keyboard input goes to the focused frame through the tab's session.
    if (text) await cdp(tabId, "Input.insertText", { text });
    else await press(tabId, "Delete");
  });
  if (submit) await press(tabId, "Enter");
  return {};
}

export async function press(tabId, key) {
  let events;
  try {
    events = keyEvents(key);
  } catch (e) {
    throw new ActionError(e.message, -32602);
  }
  await cdp(tabId, "Input.dispatchKeyEvent", events.down);
  await cdp(tabId, "Input.dispatchKeyEvent", events.up);
  await sleep(SETTLE_MS);
  return {};
}

// Chrome paints only the front tab of a window that isn't minimized. casm
// never brings a tab to the front: that is the user's call.
export async function screenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
  if (!tab.active || win.state === "minimized" || result?.value === "hidden")
    throw new ActionError(
      `the tab is not visible (${!tab.active ? "another tab is in front in its window" : win.state === "minimized" ? "its window is minimized" : "the page is hidden"}), and casm never brings tabs to the front: ask the user to show it, then try again`,
      1002,
    );
  const { data } = await Promise.race([
    cdp(tabId, "Page.captureScreenshot", { format: "png" }),
    sleep(SCREENSHOT_WAIT_MS).then(() => {
      throw new ActionError("the screenshot did not come: Chrome may not be painting the tab (is its window covered?); ask the user to bring it to the front", 1002);
    }),
  ]);
  return { data };
}

export async function evaluate(tabId, expression) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new ActionError(`the page threw: ${d.exception?.description ?? d.text}`, -32603);
  }
  return { value: r.result?.value ?? null };
}

// Without a response: just reports the open dialog (the caller adds it).
export async function dialog(tabId, response, text) {
  const s = state(tabId);
  if (!response) return {};
  if (!s.dialog) throw new ActionError("no dialog is open in the tab");
  const { session } = s.dialog;
  await cdp(tabId, "Page.handleJavaScriptDialog", { accept: response === "accept", ...(text !== undefined ? { promptText: text } : {}) }, session);
  s.dialog = null;
  await sleep(SETTLE_MS);
  return {};
}

// Files built in the page from their bytes (they come from the agent's
// machine, not this one) and set on the input, as if the user picked them.
export async function upload(tabId, ref, files) {
  const set = await onNode(tabId, ref, async (backendNodeId, session) => {
    const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId }, session);
    return cdp(
      tabId,
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function (files) {
          const isFile = (e) => e instanceof HTMLInputElement && e.type === "file";
          const all = [...document.querySelectorAll("input[type=file]")];
          const input = isFile(this) ? this
            : (this.querySelector && this.querySelector("input[type=file]"))
            || (this.control && isFile(this.control) ? this.control : null)
            || (all.length === 1 ? all[0] : null);
          if (!input) throw new Error(all.length ? "that is not a file input, and its frame has " + all.length + " of them: give the input's ref" : "there is no file input there");
          if (files.length > 1 && !input.multiple) throw new Error("this input takes one file");
          const dt = new DataTransfer();
          for (const f of files) {
            const bin = atob(f.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], f.name, { type: f.mimeType || "" }));
          }
          input.files = dt.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return input.files.length;
        }`,
        arguments: [{ value: files }],
        returnByValue: true,
      },
      session,
    );
  });
  if (set.exceptionDetails) throw new ActionError(set.exceptionDetails.exception?.description?.split("\n")[0] ?? set.exceptionDetails.text, -32602);
  return {};
}

export function downloads(tabId) {
  return (tabs.get(tabId)?.downloads ?? []).map(({ guid: _, frame: __, ...d }) => ({ ...d, tabId }));
}

// The page that started the download fetches it again, with its cookies.
// Works for most links and blob: URLs still alive; not for one-time links or
// downloads a form POST started.
export async function fetchDownload(tabId, n, maxBytes) {
  const d = tabs.get(tabId)?.downloads.find((x) => x.n === n);
  if (!d) throw new ActionError(`the tab has no download ${n} (casm browser downloads lists them)`);
  const fn = `async (url, max) => {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const b = await r.blob();
    if (b.size > max) throw new Error("it is " + b.size + " bytes, more than " + max);
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { data: btoa(s), mimeType: b.type };
  }`;
  const r = await cdp(
    tabId,
    "Runtime.evaluate",
    { expression: `(${fn})(${JSON.stringify(d.url)}, ${maxBytes})`, awaitPromise: true, returnByValue: true },
    await sessionOf(tabId, d.frame).catch(() => undefined),
  );
  if (r.exceptionDetails)
    throw new ActionError(`the page could not fetch ${d.url} again (${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}): ask the user for the file`, -32603);
  const { guid: _, frame: __, ...info } = d;
  return { download: { ...info, tabId }, ...r.result.value };
}

// What agents do in a shared tab, over chrome.debugger (the Chrome DevTools
// Protocol). The caller (background.js) has already checked the tab is shared
// and attached the debugger.
import { formatAXTree } from "./snapshot.js";
import { keyEvents } from "./keys.js";

// An error the server passes on with this JSON-RPC code (1001: NotFound).
export class ActionError extends Error {
  constructor(message, code = 1001) {
    super(message);
    this.code = code;
  }
}

const LOAD_WAIT_MS = 10_000;
const SCREENSHOT_WAIT_MS = 8_000;

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

// Refs from each tab's last snapshot (eN → backendDOMNodeId). In memory: a
// restarted service worker or a navigation asks for a new snapshot.
const refs = new Map();
export function forgetTab(tabId) {
  refs.delete(tabId);
}

function node(tabId, ref) {
  const id = refs.get(tabId)?.[ref];
  if (!id) throw new ActionError(`unknown ref ${ref}: take a new snapshot (refs last until the next snapshot or navigation)`);
  return id;
}

// CDP's "No node with given id" means the page changed under the ref.
async function onNode(tabId, ref, fn) {
  const backendNodeId = node(tabId, ref);
  try {
    return await fn(backendNodeId);
  } catch (e) {
    if (/node|object/i.test(String(e?.message))) throw new ActionError(`ref ${ref} is stale (${e.message}): take a new snapshot`);
    throw e;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new ActionError(message, -32603)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

async function waitForLoad(tabId) {
  const until = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (result?.value === "complete") return;
    } catch {
      // The old document is going away mid-navigation; ask again.
    }
  }
}

export async function snapshot(tabId) {
  await cdp(tabId, "DOM.enable");
  await cdp(tabId, "Accessibility.enable");
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
  const out = formatAXTree(nodes);
  refs.set(tabId, out.refs);
  return { text: out.text };
}

export async function navigate(tabId, url) {
  refs.delete(tabId);
  const r = await cdp(tabId, "Page.navigate", { url });
  if (r.errorText) throw new ActionError(`could not open ${url}: ${r.errorText}`, -32603);
  await waitForLoad(tabId);
  return {};
}

export async function click(tabId, ref) {
  await onNode(tabId, ref, async (backendNodeId) => {
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { quads } = await cdp(tabId, "DOM.getContentQuads", { backendNodeId });
    const q = quads?.[0];
    if (!q) throw new ActionError(`${ref} has no visible box to click`);
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  });
  return {};
}

export async function type(tabId, ref, text, submit) {
  await onNode(tabId, ref, async (backendNodeId) => {
    await cdp(tabId, "DOM.focus", { backendNodeId });
    // Select what's there, so the text replaces it, as typing over a selection does.
    const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
    await cdp(tabId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function () {
        if (typeof this.select === "function" && "value" in this) this.select();
        else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      }`,
    });
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
  return {};
}

export async function screenshot(tabId) {
  const { data } = await withTimeout(
    cdp(tabId, "Page.captureScreenshot", { format: "png" }),
    SCREENSHOT_WAIT_MS,
    "the screenshot did not come: Chrome may not paint a hidden tab or a minimized window",
  );
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

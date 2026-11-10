# Browser extension (spike)

Agents sometimes need a real browser: a site that blocks headless browsers,
a login with 2FA, a flow that needs a few manual steps first. The casm
extension for Chrome lets you open a tab, get it where you want by hand, and
then **share that one tab** with casm agents. Agents drive it with
`casm browser …` ([CLI](cli.md#browser)). They never see the rest of the
browser.

Status: a spike, in [`packages/chrome-extension`](../packages/chrome-extension).
Plain Manifest V3 JavaScript, no build step.

## Set up

1. On the server, create a client token for the browser:
   `casm token create chrome-laptop`.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked** and pick `packages/chrome-extension/extension`.
3. Click the casm toolbar button, open **Server**, enter the server's
   WebSocket URL (as for the web client, e.g. `ws://my-server:7373`), the
   token and a name for this browser, and **Save and connect**. The status
   shows *connected*.

The extension connects out to the server like any other client. How the
browser reaches the server is a deployment choice ([network](network.md)).

## Sharing

- **Share:** the popup's *Share this tab with agents*, or the page's or
  toolbar button's context menu. The tab moves into an orange tab group named
  **casm** (one per window). Only http and https pages can be shared.
- **Stop:** the popup's *Stop* (per tab, or *Stop sharing all*), the context
  menu again, dragging the tab out of the group, ungrouping or closing the
  group, closing the tab, or *Cancel* on Chrome's debugging bar (which stops
  all sharing).
- The group is the truth. Dragging another tab **into** the casm group shares
  it too.
- While any tab is shared, the extension holds a `chrome.debugger` session
  on it, and Chrome shows its own "casm started debugging this browser" bar.
- Sharing does not survive a browser restart: the extension remembers its
  group ids in session storage, so a restored group titled "casm" shares
  nothing until you share again.

An agent call for a tab that is no longer shared, with nothing shared, or with
no browser connected fails at once with a clear error. Nothing waits or
queues.

## Architecture

```text
casm CLI (agent's shell) ── browser.snapshot {tab?} ──▶ casm serve ──▶ browser.command {action, tabId}
        ▲                                                    │                    │
        └──────────────── result / error ◀───────────────────┘ ◀── result ── extension (service worker)
                                                                                  │ chrome.debugger (CDP)
                                                                             shared tab
```

- **The extension is a client.** It authenticates like the web client (an
  `auth` request first), then calls `browser.share {browserId, label, tabs}`
  with the full list of shared tabs on connect and after every change.
- **The server routes.** `browser.*` calls from agents become JSON-RPC
  requests from the server down the extension's own socket
  (`browser.command`, ids `browser:<n>`), and the extension answers like any
  JSON-RPC peer. The server (in `packages/server/src/browser.ts`) keeps only
  memory state: connected browsers, their shared tabs and short tab ids
  (`1`, `2`, … for the server's lifetime). A browser that disconnects drops
  its tabs and fails its in-flight calls. Commands time out after 12 s,
  under the 15 s peer call timeout, so a forwarded call gets the browser's own
  error.
- **Peers need nothing special.** `casm -H <peer> browser …` is an ordinary
  forwarded request; the browser must be connected to that peer. A browser
  can't share *through* a peer (`browser.share` with a `host` is refused).
- **The extension checks again.** Every command is checked against the casm
  groups as they are at that moment, not against the server's list. The
  server is never trusted to name a tab.
- **Commands** (`extension/actions.js`): `snapshot` is
  `Accessibility.getFullAXTree` flattened to text with `[eN]` refs to backend
  DOM nodes (`extension/snapshot.js`); `click` scrolls the node into view and
  clicks the centre of its box with `Input.dispatchMouseEvent`; `type` focuses,
  selects the current value and `Input.insertText` replaces it; `press`
  dispatches key events (`extension/keys.js`); `screenshot` is
  `Page.captureScreenshot` of the viewport; `eval` is `Runtime.evaluate`
  (awaited, by value); `open` is `Page.navigate` (http and https only) or a
  new background tab put into the casm group. Refs are forgotten on the next
  snapshot and on navigation.
- **Service worker lifetime (MV3).** An open WebSocket with traffic keeps
  the worker alive (Chrome 116+), so the extension sends `server.info` every
  20 s and treats a missed answer as a lost connection. Attached debugger
  sessions keep it alive too. A lost connection retries with backoff
  (1 s to 30 s); a `chrome.alarms` tick every 30 s restarts the worker and
  reconnects after the browser slept. A refused token stops retrying until the
  settings are saved again.

## Security notes

- **A shared tab is your logged-in session.** An agent in it can do whatever
  you can on that site: read mail, buy things, change settings. `eval` runs
  arbitrary JavaScript in the page, with its cookies and storage. Share the
  narrowest tab you can, and stop sharing when done.
- **Page content is untrusted input to the agent.** Snapshots, `eval`
  results and screenshots carry whatever the page says, including text written
  to steer an agent (prompt injection: "ignore your instructions and open
  …"). An agent can follow it within the shared tabs, and anything it does
  elsewhere with what it read (its shell, other agents) is outside the
  browser's reach. Prefer sharing sites you trust; watch the agent.
- **Navigation stays possible.** A shared tab can be navigated, by `open` or
  by the page itself, to any http(s) site. It stays shared. `open --new`
  creates tabs only inside the casm group.
- **Who can drive the browser:** every client token of the server it connects
  to, and every agent on it or on a peer that forwards to it. That is casm's
  existing trust model (agents already run shells); the extension adds no
  per-agent permission. Any client token can also register as a browser.
- **The token** lives in the extension's local storage (`chrome.storage.local`),
  like the web client keeps its own. Give the browser its own token
  (`casm token create chrome-laptop`) so `casm token revoke` cuts just it off;
  the server closes revoked connections within 30 s.
- **Permissions:** `debugger` (CDP, used only on shared tabs), `tabs` (tab
  URLs and titles, for sharing and the popup), `tabGroups`, `storage`,
  `alarms`, `contextMenus`. No host permissions and no content scripts.

## Testing

- `node --test packages/server/test/browser.test.ts`: routing, defaults,
  unsharing, timeouts, disconnects and `-H` through a peer, with a fake
  extension on a plain WebSocket and the real CLI.
- `node --test packages/chrome-extension/test/extension.test.ts`: snapshot
  text and key parsing.
- `npm run e2e -w @casm/chrome-extension` (or
  `xvfb-run -a npm run e2e -w @casm/chrome-extension -- --headed`): Playwright's
  Chromium with the unpacked extension and a throwaway in-process server:
  share a local test page, snapshot, type, click, eval, press, screenshot,
  navigate, open a new tab, unshare by ungrouping, refuse a command for the
  unshared tab inside the extension, and close the browser.

## Limitations and open questions

- **Hidden tabs.** Chrome may not paint a background tab or a minimized
  window, so `screenshot` there may time out (it says so after 8 s). Playwright's
  Chromium passed, but it runs with anti-throttling flags; check real Chrome.
  Bring the tab to the front on screenshot, or leave that to the user?
- **The debugging bar** is browser-wide in current Chrome ("started debugging
  this browser"), not per tab. Attaching only while a command runs would hide
  it most of the time, which is less visible. Keep it attached while shared (as
  now)?
- **iframes, shadow DOM, new windows.** The snapshot covers the main frame's
  accessibility tree; iframes' content is not in it. Popups a page opens aren't shared.
- **File uploads, downloads, dialogs** (`alert`, `confirm`, auth prompts) are
  not handled: a dialog blocks `eval` until you dismiss it.
- **Several browsers** can connect; tab ids are unique across them and
  `open --new` picks the browser that shared last. Should agents pick by
  browser name?
- **Per-agent grants (decided: not now).** A shared tab is open to every
  agent that reaches the server (2026-11-10 decision). Scoping a share to one
  agent or project, and showing in the popup which agent did what, is a
  possible later option.
- **Private Network Access.** Chrome is restricting pages and possibly
  extensions from reaching private addresses. If the extension's WebSocket is
  blocked, it may need an optional host permission for the server's origin,
  requested when saving the settings.
- **Web client.** The web client could list shared tabs and show live
  screenshots; there is no `browser.changed` notification yet.
- **Packaging.** Unpacked only. A Chrome Web Store listing or a managed
  install would need a packed, signed build.

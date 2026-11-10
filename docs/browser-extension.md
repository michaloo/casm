# Browser extension (spike)

Agents sometimes need a real browser: a site that blocks headless browsers,
a login with 2FA, a flow that needs a few manual steps first. The casm
extension for Chrome and other Chromium browsers lets you open a tab, get it
where you want by hand, and then **share that one tab** with casm agents.
Agents drive it with `casm browser …` ([CLI](cli.md#browser)). They never see
the rest of the browser.

Status: a spike, in [`packages/chrome-extension`](../packages/chrome-extension).
Plain Manifest V3 JavaScript, no build step, Chrome 125 or later.

## Set up

1. On the server, create a client token per browser:
   `casm token create chrome-laptop`.
2. In the browser, open `chrome://extensions`, turn on **Developer mode**,
   choose **Load unpacked** and pick `packages/chrome-extension/extension`.
3. Click the casm toolbar button, open **Server**, enter the server's
   WebSocket URL (as for the web client, e.g. `ws://my-server:7373`), the
   token and, optionally, a name for this browser, and **Save and connect**.
   Chrome asks to allow access to the server's host: allow it (see
   [local network access](#local-network-access)). The status shows
   *connected*.

The extension connects out to the server like any other client. How the
browser reaches the server is a deployment choice ([network](network.md)).

It needs no Google service: no Web Store, no sign-in, no sync. It works the
same in Chrome and in Chromium builds without Google services, such as
ungoogled Chromium, side by side.

## Sharing

- **Share:** the popup's *Share this tab with agents*, or the page's or
  toolbar button's context menu. The tab moves into an orange tab group named
  **casm** (one per window). Only http and https pages can be shared.
- **Stop:** the popup's *Stop* (per tab, or *Stop sharing all*), the context
  menu again, dragging the tab out of the group, ungrouping or closing the
  group, or closing the tab.
- The group is the truth. Dragging another tab **into** the casm group shares
  it too.
- **Tabs a shared tab opens are shared too.** `window.open`, `target=_blank`
  links and sign-in popups ("Sign in with …", OAuth) join the casm group, or,
  in a popup window Chrome won't group, are tracked by the extension until
  they close. This is deliberate: those flows continue in the new tab, and an
  agent stuck at "a window opened" is no help. The agent sees them in the
  answer to the command that opened them ("opened tab 4 … opened by 2") and
  in `casm browser tabs`. Unshare them like any other tab.
- **Chrome's debugging bar shows while agents work.** The extension attaches
  `chrome.debugger` to a shared tab when an agent command arrives, and
  detaches 30 s after the last one, so Chrome's own "casm started debugging
  this browser" bar is an activity light, not a sharing light (the casm group
  and the toolbar badge show sharing). It stays attached while a command
  runs, while a dialog waits for the agent and while a download runs. *Cancel*
  on the bar detaches at once but doesn't unshare: the next command attaches
  again (2026-11-10 decision).
- Sharing does not survive a browser restart: the extension remembers its
  group ids in session storage, so a restored group titled "casm" shares
  nothing until you share again.

An agent call for a tab that is no longer shared, with nothing shared, or with
no browser connected fails at once with a clear error. Nothing waits or
queues.

## Several browsers

Any number of browsers can connect to one server, e.g. Chrome and ungoogled
Chromium. Each has a name: the one set in its popup, else its kind
(`chrome`, `chromium`, `edge`, `brave`…). The server makes names unique (a
second `chromium` becomes `chromium-2`). `casm browser list` shows them with
their shared tab counts.

Tab ids are unique across browsers, so `--tab` alone names the browser too.
`--browser <name>` picks a browser's most recently shared tab. With one
browser connected neither is needed. With several and neither given, a call
fails and lists the browsers' names: casm doesn't guess.

## What agents can do

| Command | How |
| --- | --- |
| `snapshot` | `Accessibility.getFullAXTree` of every frame, flattened to text with `[eN]` refs to DOM nodes (`extension/snapshot.js`). Each iframe's content sits under its `Iframe` line. |
| `click <ref>` | scrolls the node (and its iframes) into view, clicks the centre of its box with `Input.dispatchMouseEvent` |
| `type <ref> <text>` | focuses, selects the current value, `Input.insertText` replaces it; `--submit` presses Enter |
| `press <key>` | key events (`extension/keys.js`), with editing commands for Control/Meta+A, C, X, V, Z |
| `screenshot` | `Page.captureScreenshot` of the viewport, only when the tab is in front (below) |
| `eval <js>` | `Runtime.evaluate` in the page's main frame, awaited, by value |
| `open <url>` | `Page.navigate` (http and https only), or `--new`: a new background tab in the casm group |
| `dialog [accept [text] \| dismiss]` | shows or answers an open alert, confirm, prompt or beforeunload dialog |
| `upload <ref> <file>…` | sets files from the agent's machine on a file input |
| `downloads`, `download <id>` | lists downloads shared tabs started, fetches one's content |

Refs are forgotten on the next snapshot and on navigation.

- **iframes.** Same-origin frames share the tab's debugger session;
  cross-origin ones run in their own process and get a session each, through
  `Target.setAutoAttach` with flat sessions (`chrome.debugger` supports
  them from Chrome 125). A ref remembers its frame's session; a click adds up
  the offsets of the iframes above the node, and the input goes to the tab,
  which routes it into the frame. `eval` runs in the top frame only.
- **Hidden tabs.** Chrome paints only the front tab of a window that isn't
  minimized, and casm never brings a tab to the front: that's the user's call.
  `screenshot` checks first (the tab is active in its window, the window isn't
  minimized, the page isn't hidden) and otherwise fails at once with "ask the
  user to show it". A front tab whose window is covered may still not paint:
  that fails after 8 s with the same advice. `open --new` opens tabs in the
  background for the same reason. Other commands work in background tabs.
- **Dialogs.** A JavaScript dialog blocks its page: the extension sees it open
  (`Page.javascriptDialogOpening`) and the command that caused it returns at
  once with the dialog, which the CLI prints ("a confirm dialog is open:
  "Leave?"; answer it: casm browser dialog accept|dismiss"). While it is open,
  every other command on the tab fails at once (error 1002) with the same
  advice, and the debugger stays attached so the agent can answer it. Only the
  agent (`casm browser dialog accept [text]|dismiss`) or the user answers it;
  casm never does. A dialog that opens while no agent is working (the
  debugger detached) is the user's: Chrome shows it as usual, and a new
  debugger session can neither see nor answer it. The page is blocked then, so
  the next command fails within 2 s with "a dialog is probably open in the
  browser … ask the user to answer it".
- **Uploads.** The files are read on the agent's machine and sent over the
  connection (10 MiB in all, base64 inside one message). In the page, the
  extension builds `File` objects from the bytes, sets them on the input with
  a `DataTransfer` and fires `input` and `change`, as if the user had picked
  them. The ref may be the file input, an element holding one (a styled
  "Choose file" button's label), or anything in a frame with exactly one file
  input. Drag-and-drop-only upload areas aren't supported.
- **Downloads.** The extension records downloads a shared tab starts
  (`Page.downloadWillBegin`, `Page.downloadProgress`); ids are
  `<tab>.<n>`. `casm browser download <id> -o path` fetches the file
  **again**, inside the page that started it (so with its cookies), and
  writes it on the agent's machine, 10 MiB at most. That works for ordinary
  links and blob: URLs still alive. It fails for one-time links, downloads a
  form POST started and cross-origin URLs the page may not fetch; the error
  says to ask the user for the file. The file Chrome saved stays on the
  browser's machine, untouched. Only downloads that start while the debugger
  is attached are seen: during agent work and the 30 s after it, which covers
  downloads an agent's click starts.

## Architecture

```text
casm CLI (agent's shell) ── browser.snapshot {tab?, browser?} ──▶ casm serve ──▶ browser.command {action, tabId}
        ▲                                                            │                    │
        └──────────────── result / error ◀───────────────────────────┘ ◀── result ── extension (service worker)
                                                                                          │ chrome.debugger (CDP)
                                                                                     shared tabs
```

- **The extension is a client.** It authenticates like the web client (an
  `auth` request first), then calls `browser.share {browserId, label, tabs}`
  with the full list of shared tabs (and which shared tab opened which) on
  connect and after every change.
- **The server routes.** `browser.*` calls from agents become JSON-RPC
  requests from the server down the extension's own socket
  (`browser.command`, ids `browser:<n>`), and the extension answers like any
  JSON-RPC peer. Answers carry the tab's title and URL, an open dialog and
  tabs opened since the last answer. The server (in
  `packages/server/src/browser.ts`) keeps only memory state: connected
  browsers, their shared tabs and short tab ids (`1`, `2`, … for the server's
  lifetime). A browser that disconnects drops its tabs and fails its in-flight
  calls. Commands time out after 12 s, under the 15 s peer call timeout, so a
  forwarded call gets the browser's own error.
- **Peers need nothing special.** `casm -H <peer> browser …` is an ordinary
  forwarded request; the browser must be connected to that peer. A browser
  can't share *through* a peer (`browser.share` with a `host` is refused).
- **The extension checks again.** Every command is checked against the casm
  groups (and tracked popups) as they are at that moment, not against the
  server's list. The server is never trusted to name a tab.
- **Service worker lifetime (MV3).** An open WebSocket with traffic keeps
  the worker alive (Chrome 116+), so the extension sends `server.info` every
  20 s and treats a missed answer as a lost connection. A lost connection retries with backoff
  (1 s to 30 s); a `chrome.alarms` tick every 30 s restarts the worker and
  reconnects after the browser slept. A refused token stops retrying until the
  settings are saved again.

### Local network access

Chrome is rolling out Local Network Access: pages need the user's permission
to reach private and loopback addresses, WebSockets included from Chrome 147.
Today the extension's service worker isn't checked (Chrome treats extension
origins as loopback), and extensions holding host permission for an address
are exempt. So that the connection keeps working whichever way Chrome goes,
saving the settings asks for host access to the server's host only
(`ws://host/*` and `http://host/*`, or `wss`/`https`), from the manifest's
`optional_host_permissions`. Declining doesn't stop the connection today;
the popup then shows a warning with an *Allow access* button.

## Security notes

- **A shared tab is your logged-in session.** An agent in it can do whatever
  you can on that site: read mail, buy things, change settings. `eval` runs
  arbitrary JavaScript in the page, with its cookies and storage, and
  `download` fetches with them too. Share the narrowest tab you can, and stop
  sharing when done.
- **Page content is untrusted input to the agent.** Snapshots, `eval`
  results, dialog texts, downloaded files and screenshots carry whatever the
  page says, including text written to steer an agent (prompt injection:
  "ignore your instructions and open …"). An agent can follow it within the
  shared tabs, and anything it does elsewhere with what it read (its shell,
  other agents) is outside the browser's reach. Prefer sharing sites you
  trust; watch the agent.
- **Sharing spreads to opened tabs.** A shared page can open new tabs and
  popups, and they are shared automatically (above). A page can navigate
  itself, or be navigated by `open`, to any http(s) site and stay shared.
  `open --new` creates tabs only inside the casm group.
- **Uploads leave the agent's machine.** `upload` sends files the agent can
  read to the page; it is the agent's choice which ones.
- **Who can drive the browser:** every agent that reaches the server (and
  every client token): shared tabs are open to all of them. That is casm's
  existing trust model (agents already run shells). Any client token can
  also register as a browser.
- **The token** lives in the extension's local storage (`chrome.storage.local`),
  like the web client keeps its own. Give each browser its own token
  (`casm token create chrome-laptop`) so `casm token revoke` cuts just it off;
  the server closes revoked connections within 30 s.
- **Permissions:** `debugger` (CDP, used only on shared tabs), `tabs` (tab
  URLs and titles, for sharing and the popup), `tabGroups`, `storage`,
  `alarms`, `contextMenus`, and optional host access to the server's host
  only. No content scripts.

## Testing

- `node --test packages/server/test/browser.test.ts`: routing, defaults,
  several browsers (names, ambiguity, `--browser`, `--tab`), unsharing,
  timeouts, disconnects, dialogs and opened tabs in results, uploads and the
  size cap, downloads, and `-H` through a peer, with fake extensions on plain
  WebSockets and the real CLI.
- `node --test packages/chrome-extension/test/extension.test.ts`: snapshot
  text and key parsing.
- `npm run e2e -w @casm/chrome-extension` (or
  `xvfb-run -a npm run e2e -w @casm/chrome-extension -- --headed`): Playwright's
  Chromium with the unpacked extension, in two profiles, and a throwaway
  in-process server. It shares local test pages and drives them through the
  CLI: snapshot, type, click, eval, press, screenshot, navigate; same- and
  cross-origin iframes (click and type inside them); confirm and prompt
  dialogs; an upload; a download fetched back; a popup shared automatically;
  a background tab refused for a screenshot; two browsers and the ambiguity
  error; the debugger attaching per command and detaching when idle, with refs
  (cross-origin frames included) still working after a re-attach, staying
  attached while a dialog waits, and a dialog opened while detached reported
  as the user's; unsharing by ungrouping; a command for the unshared tab refused
  inside the extension; the popup's missing-access warning; and closing the
  browser.
- Not tested here: real Chrome and ungoogled Chromium (Playwright's Chromium
  is close to the latter: no Google services), the permission prompt (no one
  to click it), and painting of covered windows.

## Limitations and open questions

- **The debugging bar** is browser-wide in current Chrome ("started debugging
  this browser"), not per tab, and appearing and disappearing shifts page
  content. Considered and not taken: keeping it attached while shared (always
  on), content scripts without the debugger (lower fidelity, broad site
  permissions), and Chrome's `--silent-debugger-extension-api` flag (silences
  it for every extension).
- **Shadow DOM, canvas, PDFs.** Open shadow roots are in the accessibility
  tree; canvas-drawn UIs and Chrome's PDF viewer aren't readable as text
  (use `screenshot`). `eval` doesn't reach into iframes.
- **File choosers.** Clicking a "Choose file" button opens the native chooser
  on the user's screen; use `upload` instead.
- **Per-agent grants (decided: not now).** A shared tab is open to every
  agent that reaches the server (2026-11-10 decision). Scoping a share to one
  agent or project, and showing in the popup which agent did what, is a
  possible later option.
- **Web client.** The web client could list shared tabs and show live
  screenshots; there is no `browser.changed` notification yet.
- **Packaging.** Unpacked only. A Chrome Web Store listing or a managed
  install would need a packed, signed build (and ungoogled Chromium can't use
  the Web Store anyway).

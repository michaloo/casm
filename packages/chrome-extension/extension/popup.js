// The toolbar popup: share or stop sharing the current tab, list the shared
// tabs, and the server settings. All state lives in the service worker.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

// Host access to the server, which exempts the extension from Chrome's local
// network access checks: its WebSocket URL and the same host over HTTP.
function serverOrigins(url) {
  try {
    const u = new URL(url);
    const secure = u.protocol === "wss:";
    return [`${secure ? "wss" : "ws"}://${u.hostname}/*`, `${secure ? "https" : "http"}://${u.hostname}/*`];
  } catch {
    return null;
  }
}
// Asked when the user saves (permissions.request needs their click); denied is shown, not fatal.
const requestAccess = (url) => {
  const origins = serverOrigins(url);
  return origins ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(false);
};

const STATUS = {
  idle: "starting",
  unconfigured: "not set up",
  connecting: "connecting…",
  connected: "connected",
  disconnected: "offline, retrying",
  refused: "token refused",
};

async function render() {
  const s = await ask({ type: "state" });
  $("status").textContent = STATUS[s.status] ?? s.status;
  $("status").className = `status ${s.status}`;
  $("status").title = s.detail ?? "";

  const origins = serverOrigins(s.settings.url);
  $("perm").hidden = !origins || (await chrome.permissions.contains({ origins }).catch(() => false));
  $("permHost").textContent = origins ? new URL(s.settings.url).hostname : "";

  const toggle = $("toggle");
  const cur = s.current;
  const shareable = cur && /^https?:\/\//.test(cur.url);
  toggle.disabled = !cur || (!cur.shared && !shareable);
  toggle.textContent = cur?.shared ? "Stop sharing this tab" : "Share this tab with agents";
  toggle.className = cur?.shared ? "secondary" : "";
  $("hint").textContent = cur?.shared
    ? "Agents can read and control this tab, with your logged-in session."
    : shareable
      ? "Agents will be able to read and control this tab, with your logged-in session."
      : "Only http and https pages can be shared.";

  const list = $("shared");
  list.replaceChildren(
    ...s.shared.map((t) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = t.title || t.url;
      label.title = t.url;
      const stop = document.createElement("button");
      stop.className = "unshare";
      stop.textContent = "Stop";
      stop.onclick = () => act({ type: "unshare", tabId: t.id });
      li.append(label, stop);
      return li;
    }),
  );
  $("none").hidden = s.shared.length > 0;
  $("stopAll").hidden = s.shared.length < 2;

  const form = $("settings");
  if (!form.dataset.filled) {
    form.url.value = s.settings.url;
    form.label.value = s.settings.label;
    form.label.placeholder = s.settings.defaultLabel;
    form.token.placeholder = s.settings.hasToken ? "saved (paste to replace)" : "casm token create chrome";
    form.dataset.filled = "1";
    $("settingsBox").open = !s.settings.url || s.status === "refused";
  }
  if (s.status === "refused" || s.status === "unconfigured") $("error").textContent = s.detail;
  // A failed share shows until one gets through (then only that message goes).
  else if (s.shareError || $("error").dataset.share) {
    $("error").textContent = s.shareError;
    $("error").dataset.share = s.shareError ? "1" : "";
  }
}

async function act(msg) {
  const r = await ask(msg);
  $("error").textContent = r.ok ? "" : r.error;
  if (!r.ok) $("settingsBox").open = msg.type === "save" || $("settingsBox").open;
  if (!r.ok && msg.type !== "save") $("hint").textContent = r.error;
  await render();
}

$("toggle").onclick = async () => {
  const s = await ask({ type: "state" });
  if (s.current) await act({ type: s.current.shared ? "unshare" : "share", tabId: s.current.id });
};
$("stopAll").onclick = () => act({ type: "unshareAll" });
$("settings").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = { type: "save", url: f.url.value, token: f.token.value, label: f.label.value };
  f.token.value = "";
  // Both start now, inside the click: Chrome closes the popup when its
  // permission prompt opens, and the settings must be on their way by then.
  const access = requestAccess(msg.url);
  await act(msg);
  await access;
};
$("permAllow").onclick = async () => {
  const s = await ask({ type: "state" });
  await requestAccess(s.settings.url);
  await render();
};
chrome.runtime.onMessage.addListener((m) => m.type === "changed" && void render());
void render();

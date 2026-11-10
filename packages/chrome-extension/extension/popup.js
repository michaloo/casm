// The toolbar popup: share or stop sharing the current tab, list the shared
// tabs, and the server settings. All state lives in the service worker.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

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
    form.token.placeholder = s.settings.hasToken ? "saved (paste to replace)" : "casm token create chrome";
    form.dataset.filled = "1";
    $("settingsBox").open = !s.settings.url || s.status === "refused";
  }
  if (s.status === "refused" || s.status === "unconfigured") $("error").textContent = s.detail;
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
$("settings").onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  void act({ type: "save", url: f.url.value, token: f.token.value, label: f.label.value });
  f.token.value = "";
};
chrome.runtime.onMessage.addListener((m) => m.type === "changed" && void render());
void render();

// What Playwright's Chromium can't show: it keeps background tabs rendering
// and handles downloads itself. This launches Playwright's Chromium binary
// bare (no Playwright flags, no CDP client on any page), drives only the
// extension's service worker over the DevTools pipe, and checks against the
// browser's real behaviour:
// - clicks and key presses in a background tab are refused at once (Chrome
//   drops them), typing there works, and the first click in a front tab
//   reports the confirm() it opens;
// - clicks land in same- and cross-origin iframes, also at device scale 2;
// - with "ask where to save each file" on (ungoogled Chromium's default), a
//   download says it waits for the save dialog instead of staying silently
//   in progress, and its content can be fetched anyway.
//
//   xvfb-run -a node packages/chrome-extension/scripts/e2e-bare.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";
import { startFixtures } from "./fixtures.ts";

const extension = join(import.meta.dirname, "../extension");
const dir = mkdtempSync(join(tmpdir(), "casm-ext-bare-"));
const web = await startFixtures(0);
const site = `http://127.0.0.1:${(web.address() as { port: number }).port}`;

async function launch(name: string, args: string[] = [], prefs?: object) {
  const profile = join(dir, name);
  if (prefs) {
    mkdirSync(join(profile, "Default"), { recursive: true });
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify(prefs));
  }
  const proc = spawn(
    chromium.executablePath(),
    [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--no-sandbox",
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args, "about:blank"],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const waiting = new Map<number, (m: { result?: any }) => void>();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const send = (method: string, params = {}, sessionId?: string) =>
    new Promise<{ result?: any }>((r) => {
      waiting.set(++id, r);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const evalIn = async (sessionId: string, expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
  // The extension's worker (Chromium runs its own component extensions too).
  let worker: string | undefined;
  for (let i = 0; i < 50 && !worker; i++) {
    for (const t of (await send("Target.getTargets")).result.targetInfos.filter((t: { type: string }) => t.type === "service_worker")) {
      const sid = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).result.sessionId;
      if ((await evalIn(sid, "typeof casm")) === "object") worker = sid;
    }
    if (!worker) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(worker, "the extension's service worker");
  const sw = <T>(expression: string) => evalIn(worker!, expression) as Promise<T>;
  // One agent command, as the server would send it; errors come back as "ERR <message>".
  const command = <T = any>(cmd: object) => sw<T | string>(`casm.command(${JSON.stringify(cmd)}).catch((e) => "ERR " + e.message)`);
  // A shared tab, opened in front or behind an empty one.
  const share = async (url: string, front: boolean) => {
    if (!front) await sw(`chrome.tabs.create({ url: "about:blank", active: true }).then(() => 1)`);
    return sw<number>(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: ${front} }).then(async (t) => { await new Promise((r) => setTimeout(r, 1500)); await casm.share(t.id); return t.id; })`);
  };
  const snapshot = async (tabId: number) => {
    const { text } = await command<{ text: string }>({ action: "snapshot", tabId }) as { text: string };
    return (re: RegExp) => text.split("\n").find((l) => re.test(l))!.match(/\[(e\d+)\]/)![1];
  };
  return { sw, command, share, snapshot, close: () => (ws.close(), proc.kill()) };
}

const browsers: { close: () => void }[] = [];
try {
  // Background tabs: clicks and keys refused, typing fine; the first click in front reports its dialog.
  const b = await launch("plain");
  browsers.push(b);
  const back = await b.share(`${site}/tools`, false);
  let ref = await b.snapshot(back);
  assert.match(String(await b.command({ action: "click", tabId: back, ref: ref(/button "Ask"/) })), /^ERR the tab is not visible \(another tab is in front in its window\): Chrome doesn't deliver clicks/);
  assert.match(String(await b.command({ action: "press", tabId: back, key: "Tab" })), /^ERR .*doesn't deliver key presses/);
  const login = await b.share(`${site}/`, false);
  const loginRef = await b.snapshot(login);
  assert.equal(await b.command({ action: "type", tabId: login, ref: loginRef(/textbox "Email"/), text: "behind@example.com" }).then(() => b.command({ action: "eval", tabId: login, expression: "document.getElementById('email').value" })).then((r: any) => r.value), "behind@example.com");
  await b.sw(`chrome.tabs.update(${back}, { active: true }).then(() => new Promise((r) => setTimeout(r, 300)))`);
  const asked = await b.command<{ dialog?: { type: string; message: string } }>({ action: "click", tabId: back, ref: ref(/button "Ask"/) });
  assert.deepEqual((asked as { dialog?: object }).dialog && { ...(asked as any).dialog, url: undefined }, { type: "confirm", message: "Leave?", url: undefined }, "the first click reports the confirm");
  await b.command({ action: "dialog", tabId: back, response: "dismiss" });
  console.log("background tabs: clicks and keys refused, typing works, the first front click reports its confirm");

  // iframes, in front.
  const frames = await b.share(`${site}/frames`, true);
  ref = await b.snapshot(frames);
  await b.command({ action: "click", tabId: frames, ref: ref(/button "Cross button"/) });
  await b.command({ action: "click", tabId: frames, ref: ref(/button "Same button"/) });
  const after = String(((await b.command({ action: "snapshot", tabId: frames })) as { text: string }).text);
  assert.match(after, /button "Cross button clicked"/);
  assert.match(after, /button "Same button clicked"/);
  console.log("iframes: clicks land in both");
  b.close();

  // The same at device scale 2 (Retina), and downloads with a save-as prompt.
  const hi = await launch("retina", ["--force-device-scale-factor=2"], { download: { prompt_for_download: true } });
  browsers.push(hi);
  const frames2 = await hi.share(`${site}/frames`, true);
  ref = await hi.snapshot(frames2);
  await hi.command({ action: "click", tabId: frames2, ref: ref(/button "Cross button"/) });
  await hi.command({ action: "click", tabId: frames2, ref: ref(/button "Same button"/) });
  const after2 = String(((await hi.command({ action: "snapshot", tabId: frames2 })) as { text: string }).text);
  assert.match(after2, /Cross button clicked/);
  assert.match(after2, /Same button clicked/);
  console.log("iframes at scale 2: clicks land in both");

  const tools = await hi.share(`${site}/tools`, true);
  ref = await hi.snapshot(tools);
  await hi.command({ action: "click", tabId: tools, ref: ref(/link "Get the report"/) });
  let list: { state: string; note?: string; n: number }[] = [];
  for (let i = 0; i < 20 && !list[0]?.note; i++) {
    await new Promise((r) => setTimeout(r, 200));
    list = ((await hi.command({ action: "downloads" })) as { downloads: typeof list }).downloads;
  }
  assert.equal(list[0]?.state, "inProgress");
  assert.equal(list[0]?.note, "waiting for the user: save dialog");
  const fetched = (await hi.command({ action: "download", tabId: tools, n: list[0].n, maxBytes: 1 << 20 })) as { data: string };
  assert.equal(Buffer.from(fetched.data, "base64").toString(), "quarterly numbers");
  console.log("downloads behind a save-as prompt: reported as waiting for it, content fetched anyway");
  // With the save dialog still up, a JS dialog in the same tab still opens and is reported.
  const asked2 = (await hi.command({ action: "click", tabId: tools, ref: ref(/button "Ask"/) })) as { dialog?: { message: string } };
  assert.equal(asked2.dialog?.message, "Leave?", "a confirm opens and is reported while the save dialog waits");
  await hi.command({ action: "dialog", tabId: tools, response: "dismiss" });
  console.log("a JS dialog while the save dialog waits: opens and is reported (Linux file chooser)");
  // The agent has the content; it cancels the download the save dialog holds.
  const canceled = (await hi.command({ action: "cancelDownload", tabId: tools, n: list[0].n })) as { download: { state: string } };
  assert.equal(canceled.download.state, "canceled");
  assert.match(String(await hi.command({ action: "cancelDownload", tabId: tools, n: list[0].n })), /^ERR it is canceled already: nothing to cancel/);
  console.log("cancel: the waiting download is canceled; a second cancel says there's nothing to cancel");
  console.log("e2e-bare: all checks passed");
} finally {
  for (const b of browsers) b.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
}

// End-to-end check that the server has the tabs the casm group shows, however
// the extension (re)connects: in Playwright's Chromium against a throwaway
// casm server with a short auth timeout.
//
//   npm run e2e:reconnect -w @casm/chrome-extension
//
// CASM_E2E_EXTENSION=<dir> runs it against another copy of the extension
// (one from before these fixes fails the first check).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Worker } from "playwright";
import { Store } from "../../server/src/db.ts";
import { startServer } from "../../server/src/server.ts";
import { startFixtures } from "./fixtures.ts";

const extension = process.env.CASM_E2E_EXTENSION ?? join(import.meta.dirname, "../extension");
const dir = mkdtempSync(join(tmpdir(), "casm-ext-reconnect-"));
const web = await startFixtures(0);
const site = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
const store = new Store(join(dir, "casm.db"));
const token = store.createToken("browser-extension");
const AUTH_TIMEOUT_MS = 1500;
const log: string[] = [];
const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "e2e", name: "e2e", authTimeoutMs: AUTH_TIMEOUT_MS, log: (m) => log.push(m) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, check: () => Promise<boolean>, ms = 5000) => {
  for (let i = 0; i < ms / 100; i++) if (await check()) return;
  else await sleep(100);
  assert.fail(`timed out waiting until ${what}`);
};

// What agents see (casm browser list), over a client connection of its own.
async function serverTabs(): Promise<number | undefined> {
  const ws = new WebSocket(server.url);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      ws.addEventListener("message", function on(ev) {
        const m = JSON.parse(String(ev.data));
        if (m.id !== n) return;
        ws.removeEventListener("message", on);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  await call("auth", { token });
  const { browsers } = await call("browser.list", {});
  ws.close();
  return browsers.find((b: { name: string }) => b.name === "chromemacbook")?.tabs;
}

type State = { status: string; detail: string; shareError: string; shared: unknown[] };
const context = await chromium.launchPersistentContext(join(dir, "profile"), {
  channel: "chromium",
  headless: !process.argv.includes("--headed"),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  let worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const sw = <T>(fn: string) => worker.evaluate(fn) as Promise<T>;
  const state = () => sw<State>("casm.state()");
  const share = async (path: string) => {
    const page = await context.newPage();
    await page.goto(`${site}${path}`);
    const tabId = await sw<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${site}${path}`)} }).then((t) => t[0].id)`);
    await sw(`casm.share(${tabId})`);
    return tabId;
  };
  await sw(`casm.saveSettings({ url: ${JSON.stringify(server.url)}, token: ${JSON.stringify(token)}, label: "chromemacbook" })`);
  await until("connected", async () => (await state()).status === "connected");

  // Two connects at once (the alarm, a retry, a save, the worker starting can overlap): one socket
  // only. The other, never authenticated, used to be closed by the server
  // with 4401, which turned the live connection's status to "refused" and
  // dropped every share after it while agent commands still worked.
  await sw("casm.reconnect(), casm.reconnect()");
  await sleep(AUTH_TIMEOUT_MS + 1000);
  assert.deepEqual(log.filter((l) => l.includes("sent no auth")), [], "no second, unauthenticated socket");
  await share("/");
  await share("/next");
  await until("the server has both tabs", async () => (await serverTabs()) === 2);
  const s = await state();
  assert.equal(s.status, "connected", s.detail);
  assert.equal(s.shared.length, 2);

  // A share the server refuses shows in the popup until one gets through.
  const id = await sw<string>(`chrome.storage.local.get("browserId").then((r) => r.browserId)`);
  await sw(`chrome.storage.local.set({ browserId: 5 })`);
  await sw("casm.sync()");
  await until("the share error shows", async () => /the server didn't get the shared tabs/.test((await state()).shareError));
  await sw(`chrome.storage.local.set({ browserId: ${JSON.stringify(id)} })`);
  await sw("casm.sync()");
  await until("the share error clears", async () => (await state()).shareError === "");

  // Reloading the extension (as to fix its settings) forgets its groups: the
  // casm group Chrome still shows is ungrouped, so the user doesn't see tabs
  // as shared that the server doesn't have.
  const groupOf = (path: string) => sw<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${site}${path}`)} }).then((t) => t[0].groupId)`);
  assert.notEqual(await groupOf("/"), -1);
  // Playwright's Chromium blocks an unpacked extension that reloads itself,
  // so this plays it: the session storage a reload clears, then a worker
  // restart (stopped here; Chrome's alarm wakes it within 30 s).
  const connects = () => log.filter((l) => l.startsWith("client connected")).length;
  const before = connects();
  await sw("chrome.storage.session.clear()");
  const cdp = await context.newCDPSession(context.pages()[0]);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await until("the worker restarted", async () => {
    worker = context.serviceWorkers()[0] ?? worker;
    return connects() > before && (await sw("!!globalThis.casm").catch(() => false)) === true;
  }, 60_000);
  await sleep(AUTH_TIMEOUT_MS + 500);
  // The alarm woke it (Playwright doesn't), and connects too.
  assert.deepEqual(log.filter((l) => l.includes("sent no auth")), [], "no second socket after the alarm woke the worker");
  await until("the stray casm group is gone", async () => (await groupOf("/").catch(() => 0)) === -1 && (await groupOf("/next")) === -1);
  await until("connected again", async () => (await state().catch(() => null))?.status === "connected");
  await until("the server has no tabs", async () => (await serverTabs()) === 0);
  assert.equal((await state()).shared.length, 0);
  // Sharing again makes a casm group of ours, which stays.
  await sw(`chrome.tabs.query({ url: ${JSON.stringify(`${site}/`)} }).then((t) => casm.share(t[0].id))`);
  await until("the server has the tab", async () => (await serverTabs()) === 1);
  await sleep(300);
  assert.notEqual(await groupOf("/"), -1);
  console.log("e2e-reconnect: all checks passed");
} finally {
  await context.close();
  await server.close();
  store.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
}

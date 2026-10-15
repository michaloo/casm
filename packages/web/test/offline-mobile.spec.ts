// Offline and connection state: the banner, the read-only mode, the saved copy
// on reload with the server gone, and noticing a socket that died silently.
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome, testURL, testWS } from "./config.ts";

const server = () => Number(readFileSync(`${testHome}/web-pid`, "utf8"));
const signal = (name: NodeJS.Signals) => process.kill(server(), name);

async function login(page: any) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}
// Phones keep the sidebar behind the Agents button.
async function openAgent(page: any, name: string) {
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  if (await agents.isVisible()) await agents.click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.locator("main header strong")).toHaveText(name);
}
async function send(page: any, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: /^(Send|Queue)$/, exact: true }).click();
  await expect(page.getByLabel("Message")).toHaveValue("");
}
// The keys in the IndexedDB offline copy.
const savedKeys = (page: any) => page.evaluate(() => new Promise<string[]>((resolve) => {
  const open = indexedDB.open("casm-offline");
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("kv")) return resolve([]);
    const keys = db.transaction("kv").objectStore("kv").getAllKeys();
    keys.onsuccess = () => { resolve(keys.result.map(String)); db.close(); };
  };
  open.onerror = () => resolve([]);
}));
const banner = (page: any) => page.locator(".connection-banner");

test("offline mobile: losing the server shows the banner and makes the view read-only", async ({ page, context }) => {
  await login(page);
  await openAgent(page, "Agent 00");
  await expect(page.locator(".item").first()).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await send(page, "permission");
  await expect(page.getByText("Permission: Write")).toBeVisible();
  await send(page, "waiting in the queue");
  await expect(page.locator(".queue-toggle")).toBeVisible();
  await page.locator(".queue-toggle").click();
  await expect(page.locator(".pending-row")).toHaveCount(1);

  signal("SIGKILL"); // at once: a graceful close waits for the running turn
  await context.setOffline(true);
  await expect(banner(page)).toHaveText(/^Offline · saved copy from \d/);
  for (const name of ["Allow", "Deny", "Cancel", "Edit", "Send now"])
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toHaveAttribute("title", /^Offline: reconnect/);
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  if (await agents.isVisible()) await agents.click();
  await expect(page.getByRole("button", { name: "New project on Test host" })).toBeDisabled();
  await expect(page.locator("nav .project-row").getByText("＋")).toHaveCount(0);
  if (await page.getByRole("button", { name: "Close", exact: true }).isVisible()) await page.getByRole("button", { name: "Close", exact: true }).click();
  // The transcript stays readable and drafts can still be written.
  await expect(page.locator(".item").first()).toBeVisible();
  await page.getByLabel("Message").fill("typed while offline");
  await expect(page.getByRole("button", { name: /^(Send|Queue)$/ })).toBeDisabled();
  await expect(page.locator(".send-hint")).toContainText("draft is kept on this device");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue(/typed while offline/);
  await context.setOffline(false);
});

test("offline mobile: the saved copy renders on reload with the server down, drafts kept", async ({ page, context }) => {
  await login(page);
  await openAgent(page, "Agent 00");
  await expect(page.getByText(/Message 319/)).toBeVisible();
  const route = new URL(page.url()).pathname;
  expect(route).toMatch(/^\/h\/Test%20host\/a\//);
  await page.getByLabel("Message").fill("draft kept offline");
  // The localhost worker serves the app shell once the server is gone.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const agent = route.split("/").pop();
  await expect.poll(() => savedKeys(page)).toEqual(expect.arrayContaining(["meta", "sidebar", `chat:/${agent}`]));
  await page.waitForTimeout(300); // the draft's debounced save

  signal("SIGKILL"); // at once: a graceful close waits for the running turn
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).pathname).toBe(route);
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await expect(page.getByText(/Message 319/)).toBeVisible();
  await expect(banner(page)).toHaveText(/^Offline · saved copy from \d/);
  await expect(page.getByLabel("Message")).toHaveValue("draft kept offline");
  await expect(page.getByRole("button", { name: /^(Send|Queue)$/ })).toBeDisabled();
  // An agent never opened on this device has no saved transcript.
  await openAgent(page, "Agent 05");
  await expect(page.getByText("Not available offline")).toBeVisible();
  await context.setOffline(false);
});

test("offline mobile: a socket that died silently reconnects within the heartbeat window", async ({ page }) => {
  await page.clock.install();
  await login(page);
  await openAgent(page, "Agent 00");
  await expect(page.locator(".item").first()).toBeVisible();
  signal("SIGSTOP");
  try {
    // The socket still looks open; only the heartbeat's probe can tell.
    await page.clock.fastForward(21_000);
    await expect(banner(page)).toHaveText(/^Checking connection…/);
    await page.clock.fastForward(11_000);
    await expect(banner(page)).toHaveText(/^Reconnecting… · showing saved copy from \d/);
    await expect(page.getByRole("button", { name: /^(Send|Queue)$/ })).toBeDisabled();
  } finally {
    signal("SIGCONT");
  }
  await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
  await send(page, "back again");
  await expect(page.getByText("echo: back again", { exact: true })).toBeVisible();
});

test("offline mobile: coming back to the page checks the connection at once", async ({ page }) => {
  await login(page);
  await openAgent(page, "Agent 00");
  await expect(page.locator(".item").first()).toBeVisible();
  await page.waitForTimeout(1200);
  signal("SIGSTOP");
  const started = Date.now();
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(banner(page)).toHaveText(/^Reconnecting…/, { timeout: 8000 });
    // Well before the heartbeat would have noticed.
    expect(Date.now() - started).toBeLessThan(15_000);
  } finally {
    signal("SIGCONT");
  }
  await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".item").first()).toBeVisible();
  await send(page, "after resume");
  await expect(page.getByText("echo: after resume", { exact: true })).toBeVisible();
});

test("offline mobile: plain remote HTTP keeps the saved copy without a service worker", async ({ page }) => {
  // A non-loopback http origin mapped to the disposable server, its socket too.
  const origin = "http://casm-insecure.test";
  const workerRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/sw.js")) workerRequests.push(request.url()); });
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await page.request.get(`${testURL}${url.pathname}${url.search}`) });
  });
  let refuse = false;
  await page.routeWebSocket(/casm-insecure\.test/, (ws) => {
    if (refuse) return ws.close();
    const upstream = new WebSocket(`${testWS}${new URL(ws.url()).search}`);
    const early: string[] = [];
    upstream.onopen = () => early.splice(0).forEach((m) => upstream.send(m));
    upstream.onmessage = (m) => ws.send(String(m.data));
    upstream.onclose = () => ws.close();
    ws.onMessage((m) => upstream.readyState === WebSocket.OPEN ? upstream.send(String(m)) : early.push(String(m)));
    ws.onClose(() => upstream.close());
  });
  await page.goto(origin);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgent(page, "Agent 00");
  await expect(page.getByText(/Message 319/)).toBeVisible();
  const agent = new URL(page.url()).pathname.split("/").pop();
  await expect.poll(() => savedKeys(page)).toEqual(expect.arrayContaining(["meta", "sidebar", `chat:/${agent}`]));
  expect(workerRequests).toEqual([]);
  expect(await page.evaluate(async () => "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0)).toBe(0);
  // No notice anywhere but one quiet line in the serving host's options.
  await expect(banner(page)).toHaveCount(0);
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  if (await agents.isVisible()) await agents.click();
  await page.getByRole("button", { name: "Host options for Test host" }).click();
  await expect(page.locator(".http-note")).toHaveText("Served over HTTP: cold offline start and notifications need HTTPS (everything else works).");
  await page.getByRole("button", { name: "Close host options" }).click();

  // The app still in memory, the server unreachable: a reload with the socket
  // refused renders the saved copy from IndexedDB.
  refuse = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await expect(page.getByText(/Message 319/)).toBeVisible();
  await expect(banner(page)).toHaveText(/showing saved copy from \d/);
});

test("offline mobile: a secure origin shows no HTTP note", async ({ page }) => {
  await login(page);
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  if (await agents.isVisible()) await agents.click();
  await page.getByRole("button", { name: "Host options for Test host" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".http-note")).toHaveCount(0);
});

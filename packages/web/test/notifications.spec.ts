// Notifications: enabling Web Push on this device from the host modal (with
// the browser's PushManager mocked; there is no push service here), the device
// list, why it can be unavailable, and the service worker's click routing
// into an open window.
import { existsSync, readFileSync } from "node:fs";
import { createECDH, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome, testWS } from "./config.ts";

const token = () => readFileSync(`${testHome}/web-token`, "utf8");
const pushed = () => existsSync(`${testHome}/push-sent.jsonl`)
  ? readFileSync(`${testHome}/push-sent.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l).endpoint as string) : [];

// A browser's subscription keys: the server checks their sizes.
function keys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

// One JSON-RPC call over its own socket, as another client.
async function call(method: string, params: object): Promise<any> {
  const ws = new WebSocket(`${testWS}/?token=${encodeURIComponent(token())}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  try {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    const msg = await new Promise<any>((r) => { ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id === 1) r(d); }; });
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  } finally {
    ws.close();
  }
}

// PushManager, Notification and the worker registration, as a supporting browser has them.
async function mockPush(page: Page, opts: { permission?: string; secure?: boolean; standalone?: boolean } = {}) {
  await page.addInitScript(({ k, permission, secure, standalone }) => {
    const state: { permission: string; sub: unknown } = { permission, sub: null };
    const subscription = (endpoint: string, key: ArrayBuffer) => ({
      endpoint, options: { applicationServerKey: key },
      toJSON: () => ({ endpoint, keys: k }),
      unsubscribe: async () => { state.sub = null; return true; },
    });
    const pushManager = {
      getSubscription: async () => state.sub,
      subscribe: async (o: { applicationServerKey: Uint8Array }) =>
        (state.sub = subscription("https://push.example/this-device", o.applicationServerKey.slice().buffer)),
    };
    (window as any).PushManager ??= function PushManager() {};
    Object.defineProperty(window, "Notification", { configurable: true, value: {
      get permission() { return state.permission; },
      requestPermission: async () => (state.permission = state.permission === "denied" ? "denied" : "granted"),
    } });
    const sw = navigator.serviceWorker ?? Object.assign(new EventTarget(), { register: async () => ({}) });
    Object.defineProperty(sw, "getRegistration", { configurable: true, value: async () => ({ pushManager }) });
    if (!navigator.serviceWorker) Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
    if (!secure) Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    if (standalone) Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  }, { k: keys(), permission: opts.permission ?? "default", secure: opts.secure ?? true, standalone: opts.standalone ?? true });
}

async function login(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/^Connected$/)).toBeAttached();
}

async function openNotifications(page: Page, width: number) {
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Host options for Test host", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Test host host" });
  await panel.getByRole("button", { name: "Notifications", exact: true }).click();
  return panel.getByRole("region", { name: "Notifications" });
}

for (const width of [1440, 375]) test(`notifications: enable this device, test, list and remove devices at ${width}${width === 375 ? " mobile" : ""}`, async ({ page }, info) => {
  await mockPush(page);
  await login(page, width);
  const section = await openNotifications(page, width);
  await expect(section.getByRole("status").first()).toHaveText("Off on this device.");
  await expect(section.getByText("No devices yet.")).toBeVisible();
  await section.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await expect(section.getByText("On: this device gets notifications from agents on this host.")).toBeVisible();
  const devices = section.getByRole("list", { name: "Subscribed devices" });
  const mine = devices.getByRole("listitem").filter({ hasText: "This device" });
  await expect(mine).toContainText(info.project.name.startsWith("webkit") ? "iPhone · Home Screen app" : "Linux · Chrome app");
  await expect(mine).toContainText("push.example");

  await section.getByRole("button", { name: "Send test notification", exact: true }).click();
  await expect(section.getByText(/^Test notification sent to /)).toBeVisible();
  expect(pushed()).toEqual(["https://push.example/this-device"]);
  await expect(mine).toContainText("last notified");

  // Another device whose subscription has expired: testing it removes it.
  await call("push.subscribe", { subscription: { endpoint: "https://push.example/gone-ipad", keys: keys() }, label: "Old iPad" });
  await page.getByRole("dialog", { name: "Test host host" }).getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("dialog", { name: "Test host host" }).getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(devices.getByRole("listitem")).toHaveCount(2);
  await section.getByRole("button", { name: "Send a test notification to Old iPad", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("expired and was removed");
  await expect(devices.getByRole("listitem")).toHaveCount(1);

  if (width === 375) {
    for (const button of await section.locator("button:visible").all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await section.getByRole("button", { name: "Turn off on this device", exact: true }).click();
  await expect(section.getByRole("status").first()).toHaveText("Off on this device.");
  await expect(section.getByText("No devices yet.")).toBeVisible();
  expect((await call("push.list", {})).devices).toEqual([]);
});

const unavailable: [string, Parameters<typeof mockPush>[1], RegExp][] = [
  ["served over plain HTTP", { secure: false }, /Unavailable over plain HTTP/],
  ["blocked in the browser", { permission: "denied" }, /Blocked for this site/],
  ["an iPhone tab not on the Home Screen", { standalone: false }, /Add to Home Screen/],
];
for (const [why, opts, text] of unavailable) test(`notifications explain why they are unavailable: ${why} (mobile)`, async ({ page }, info) => {
  const iphone = info.project.name.startsWith("webkit");
  // Only an iPhone needs the Home Screen; elsewhere a tab can enable them.
  if (why.includes("iPhone") && !iphone) test.skip();
  await mockPush(page, opts);
  await login(page, 1440);
  const section = await openNotifications(page, 1440);
  await expect(section.getByRole("status").first()).toContainText(text);
  await expect(section.getByRole("button", { name: "Enable notifications" })).toHaveCount(0);
});

test("a notification click routes the open window to the agent, same-origin paths only (mobile)", async ({ page }) => {
  await mockPush(page);
  await login(page, 1440);
  const { agents } = await call("agent.list", {});
  const agent = agents.find((a: { name: string }) => a.name === "Agent 02");
  // What the service worker posts to an open window after a notification click.
  const click = (url: string) => page.evaluate((u) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "casm:navigate", url: u } })), url);
  await click(`/h/Test%20host/a/${agent.id}`);
  await expect(page).toHaveURL(new RegExp(`/h/Test%20host/a/${agent.id}$`));
  await expect(page.getByRole("main").getByText("Agent 02", { exact: true })).toBeVisible();
  await click("https://evil.example/x");
  await expect(page).toHaveURL(new RegExp(`/h/Test%20host/a/${agent.id}$`));
});

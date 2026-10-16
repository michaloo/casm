import { testHome } from "./config.ts";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

const GB = 2 ** 30;
const stats = (cpuPercent: number, usedGb: number) => ({
  cpuPercent, cores: 8, loadAverage: [1.2, 1, 0.8], memory: { total: 16 * GB, available: (16 - usedGb) * GB, used: usedGb * GB },
  swap: null, uptimeSeconds: 7200, processRss: 150 * 2 ** 20, runningAgents: 1, sampledAt: new Date().toISOString(),
});
type Reply = { result?: unknown; error?: { code: number; message: string } } | Promise<unknown>;

/** Answers host.stats from `reply`, counting calls; everything else reaches the test server. */
async function routeStats(page: Page, reply: () => Reply) {
  const seen = { calls: 0, refuse: false, sockets: [] as { close: () => Promise<void> }[] };
  await page.routeWebSocket("**", (socket) => {
    if (seen.refuse) { void socket.close(); return; }
    seen.sockets.push(socket);
    const server = socket.connectToServer();
    socket.onMessage(async (message) => {
      const request = JSON.parse(String(message));
      if (request.method !== "host.stats") { server.send(message); return; }
      seen.calls++;
      const answer = await reply();
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(answer && typeof answer === "object" && ("result" in answer || "error" in answer) ? answer : { result: answer }) }));
    });
  });
  return seen;
}

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  await expect(page.getByRole("button", { name: "Toggle Test host host" }).or(agents).first()).toBeVisible();
  if (await agents.isVisible()) await agents.click();
}

const meter = (page: Page) => page.getByRole("button", { name: /^Test host resources: / });
const slot = (page: Page) => page.locator("nav .host-heading .host-meter").first();
const shots = "/home/michaloo/Explorations/screenshots";
// Crisp copies for review.
test.use({ deviceScaleFactor: 2 });

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`host mini bars: calm tones, tooltip, no row shift, open Resources ${viewport.width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      await routeStats(page, async () => { await held; return stats(42, 6.5); });
      await connect(page);
      // The slot is reserved before the first reading, so nothing moves when the bars appear.
      const heading = page.locator("nav .host-heading").first();
      const name = page.locator("nav .host-collapse .host-name").first();
      await expect(slot(page)).toBeVisible();
      const before = { name: (await name.boundingBox())!, slot: (await slot(page).boundingBox())!, heading: (await heading.boundingBox())! };
      await expect(meter(page)).toHaveCount(0);
      release();
      await expect(meter(page)).toBeVisible();
      expect((await name.boundingBox())).toEqual(before.name);
      expect((await heading.boundingBox())).toEqual(before.heading);
      const box = (await meter(page).boundingBox())!;
      expect([box.x, box.width]).toEqual([before.slot.x, before.slot.width]);
      // Beside the chevron, inside the row.
      expect(box.x + box.width).toBeLessThanOrEqual(before.heading.x + before.heading.width);
      await expect(meter(page)).toHaveAttribute("title", "CPU 42% · RAM 6.5 of 16.0 GB");
      await expect(meter(page)).toHaveAccessibleName("Test host resources: CPU 42% · RAM 6.5 of 16.0 GB");
      const bars = meter(page).locator(".host-meter-bar");
      await expect(bars).toHaveCount(2);
      expect(await bars.evaluateAll((els) => els.map((el) => el.className))).toEqual(["host-meter-bar cpu ", "host-meter-bar ram "]);
      // Bars fill from the bottom: 42% of the track.
      const track = (await bars.first().boundingBox())!, fill = (await bars.first().locator("span").boundingBox())!;
      expect(fill.y + fill.height).toBeCloseTo(track.y + track.height, 0);
      expect(fill.height / track.height).toBeCloseTo(0.42, 1);
      mkdirSync(shots, { recursive: true });
      const sidebar = `/tmp/casm-hostbars-sidebar-${viewport.width}-${colorScheme}.png`;
      await page.locator("aside").screenshot({ path: sidebar });
      copyFileSync(sidebar, `${shots}/host-bars-sidebar-${viewport.width}-${colorScheme}.png`);
      const row = `/tmp/casm-hostbars-row-${viewport.width}-${colorScheme}.png`;
      await heading.screenshot({ path: row });
      copyFileSync(row, `${shots}/host-bars-row-${viewport.width}-${colorScheme}.png`);
      // Clicking opens the host modal on Resources, which reuses the reading.
      await meter(page).click();
      const dialog = page.getByRole("dialog", { name: "Test host host" });
      await expect(dialog.getByRole("button", { name: "Resources", exact: true })).toHaveAttribute("aria-pressed", "true");
      const resources = dialog.getByRole("region", { name: "Resources" });
      await expect(resources.getByRole("region", { name: "Host load" })).toContainText("6.5 GB of 16.0 GB");
      await expect(dialog.getByRole("region", { name: "Usage" })).toHaveCount(0);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const tab = `/tmp/casm-hostbars-resources-${viewport.width}-${colorScheme}.png`;
      await (viewport.width < 600 ? page : dialog).screenshot({ path: tab });
      copyFileSync(tab, `${shots}/host-bars-resources-tab-${viewport.width}-${colorScheme}.png`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(meter(page)).toBeFocused();
    });
  }
}

test("host mini bars: amber from 80%, red from 95%", async ({ page }) => {
  await page.clock.install();
  await routeStats(page, () => stats(85, 15.5));
  await connect(page);
  await expect(meter(page)).toHaveAttribute("title", "CPU 85% · RAM 15.5 of 16.0 GB");
  const bars = meter(page).locator(".host-meter-bar");
  await expect(bars.nth(0)).toHaveClass(/\bhigh\b/);
  await expect(bars.nth(1)).toHaveClass(/\bfull\b/);
  const colors = await bars.evaluateAll((els) => els.map((el) => getComputedStyle(el.firstElementChild!).backgroundColor));
  expect(colors[0]).not.toBe(colors[1]);
});

test("host mini bars: hidden on a host without host.stats, the slot kept", async ({ page }) => {
  const seen = await routeStats(page, () => ({ error: { code: -32601, message: "Method not found" } }));
  await connect(page);
  await expect.poll(() => seen.calls).toBeGreaterThan(0);
  await expect(meter(page)).toHaveCount(0);
  await expect(slot(page)).toHaveAttribute("aria-hidden", "true");
  expect((await slot(page).boundingBox())!.width).toBe(14);
  // The Resources tab says so instead of loading forever.
  await page.getByRole("button", { name: "Host options for Test host", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test host host" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Resources" })).toContainText("Resources unavailable on this host.");
});

test("host mini bars: hidden while the host is offline", async ({ page }) => {
  const seen = await routeStats(page, () => stats(30, 4));
  await connect(page);
  await expect(meter(page)).toBeVisible();
  // The server goes away and refuses reconnects.
  seen.refuse = true;
  for (const socket of seen.sockets) await socket.close();
  await expect(meter(page)).toHaveCount(0);
  await expect(slot(page)).toBeAttached();
  expect((await slot(page).boundingBox())!.width).toBe(14);
});

test("host mini bars poll every 30 s, pause while the page is hidden, and share readings with Resources (10 s while open)", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    (window as unknown as { setVisibility: (s: DocumentVisibilityState) => void }).setVisibility = (s) => { state = s; document.dispatchEvent(new Event("visibilitychange")); };
  });
  const seen = await routeStats(page, () => stats(20, 4));
  await connect(page);
  await expect(meter(page)).toBeVisible();
  await expect.poll(() => seen.calls).toBe(1);
  await page.clock.runFor(29_000);
  expect(seen.calls).toBe(1);
  await page.clock.runFor(2_000);
  await expect.poll(() => seen.calls).toBe(2);
  // Hidden: no reads, however long.
  await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility("hidden"));
  await page.clock.runFor(95_000);
  expect(seen.calls).toBe(2);
  // Visible again: a stale reading refreshes at once.
  await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility("visible"));
  await expect.poll(() => seen.calls).toBe(3);
  // The Resources tab shows the shared reading at once and reads every 10 s while open, not twice.
  await page.getByRole("button", { name: "Host options for Test host", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test host host" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Host load" })).toContainText("20%");
  expect(seen.calls).toBe(3);
  await page.clock.runFor(10_500);
  await expect.poll(() => seen.calls).toBe(4);
  await page.clock.runFor(10_000);
  await expect.poll(() => seen.calls).toBe(5);
  // Back on Usage: the 30 s cadence again.
  await dialog.getByRole("button", { name: "Usage", exact: true }).click();
  await page.clock.runFor(20_000);
  expect(seen.calls).toBe(5);
  await page.clock.runFor(11_000);
  await expect.poll(() => seen.calls).toBe(6);
});

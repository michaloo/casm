import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

const SHOTS = "/home/michaloo/Explorations/screenshots";
const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const now = new Date();
const dates = Array.from({ length: 7 }, (_, i) => local(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i, 12)));
const today = dates[6];
const series = (values: number[]) => values.map((costUsd, i) => ({ date: dates[i], costUsd }));
const opencode = [0, 0.0012, 0, 0.004, 0.0101, 0, 0.0026];

// Stubs provider.costs (and a Claude limits card beside it); the rest goes to the test server.
async function open(page: Page, costs: unknown[], width: number) {
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.method === "provider.costs")
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { today, timeZone: "Europe/Warsaw", costs } }));
      else if (request.method === "provider.limits")
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { limits: [{ provider: "claude", plan: "Max", updatedAt: new Date().toISOString(), windows: [
          { id: "five-hour", label: "5-hour", usedPercent: 42, status: "ok", windowMinutes: 300, resetsAt: new Date(Date.now() + 2.5 * 3600000).toISOString() },
        ] }] } }));
      else server.send(message);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width < 600) await openAgents(page);
  await page.getByRole("button", { name: /^Host options for / }).first().click();
  const dialog = page.getByRole("dialog", { name: /host$/ });
  return { dialog, panel: dialog.getByRole("region", { name: "Usage" }) };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`cost chart: a bar per day, today highlighted, values on hover/tap ${viewport.width} ${colorScheme}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      const { dialog, panel } = await open(page, [
        { provider: "opencode", days: series(opencode), totalUsd: opencode.reduce((a, b) => a + b, 0), agents: 2 },
        { provider: "pi", days: series([0, 0, 0, 0, 0, 0, 0]), totalUsd: 0, agents: 0 },
      ], viewport.width);
      const card = panel.getByRole("region", { name: "OpenCode estimated cost" });
      await expect(card).toBeVisible();
      // Beside the limit cards, in the same grid; a provider without cost gets no card.
      await expect(panel.locator(".usage-grid > .usage-card")).toHaveCount(2);
      await expect(panel.getByRole("region", { name: "Pi estimated cost" })).toHaveCount(0);
      await expect(card).toContainText("7 days · $0.02");
      await expect(card).toContainText("Estimated, as reported by OpenCode · 2 agents");
      const chart = card.getByRole("img", { name: /^Estimated cost per day over the last 7 days, \$0\.02 in total; highest .+ at \$0\.01$/ });
      await expect(chart).toBeVisible();
      // One bar per day; days without cost draw nothing.
      const bars = card.locator(".cost-bar");
      await expect(bars).toHaveCount(7);
      const heights = await bars.evaluateAll((els) => els.map((el) => (el as SVGRectElement).getBoundingClientRect().height));
      expect(heights.filter((_, i) => opencode[i] === 0).every((h) => h === 0)).toBe(true);
      expect(heights[4]).toBeGreaterThan(heights[3]);
      expect(heights[3]).toBeGreaterThan(heights[6]);
      expect(heights[6]).toBeGreaterThan(heights[1]);
      await expect(bars.nth(6)).toHaveClass(/today/);
      await expect(card.locator(".cost-days > span")).toHaveCount(7);
      await expect(card.locator(".cost-days > .today")).toHaveText("Today");
      const fills = await bars.evaluateAll((els) => els.map((el) => getComputedStyle(el).fill));
      expect(fills[6]).not.toBe(fills[4]);
      // The readout shows today until a day is hovered (mouse) or tapped (touch).
      const readout = card.locator(".cost-readout");
      await expect(readout).toHaveText("Today$0.0026");
      const hit = card.locator(".cost-hit").nth(4);
      const touch = !!info.project.use.hasTouch;
      if (touch) await hit.tap();
      else await hit.hover();
      await expect(readout).toContainText("$0.01");
      await expect(readout).not.toContainText("Today");
      await expect(bars.nth(4)).toHaveClass(/picked/);
      await card.screenshot({ path: `${SHOTS}/cost-chart-${viewport.width}-${colorScheme}${touch ? "-webkit" : ""}.png` });
      if (touch) await hit.tap();
      else await page.mouse.move(2, 2);
      await expect(readout).toHaveText("Today$0.0026");
      // Screen readers get every day as a table.
      await expect(card.locator("table tbody tr")).toHaveCount(7);
      await expect(card.locator("table tbody tr").last()).toContainText("$0.0026");
      // Inside the dialog, nothing overflowing.
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const box = (await card.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await panel.screenshot({ path: `${SHOTS}/cost-chart-usage-${viewport.width}-${colorScheme}${touch ? "-webkit" : ""}.png` });
    });
  }
}

test("cost chart: no cards when nothing has a cost", async ({ page }) => {
  const { panel } = await open(page, [{ provider: "opencode", days: series([0, 0, 0, 0, 0, 0, 0]), totalUsd: 0, agents: 0 }], 1440);
  await expect(panel.getByRole("region", { name: "Claude" })).toBeVisible();
  await expect(panel.locator(".cost-card")).toHaveCount(0);
});

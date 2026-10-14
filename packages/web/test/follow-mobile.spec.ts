import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { testHome } from "./config.ts";

// While the reader follows the end, rows that grow after they mount (Thinking,
// a running tool's output, a streamed reply) must stay fully visible, and
// Latest ↓ must not appear without a scroll-up.
async function lastRowVisible(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-item-index]")];
    const last = rows.sort((a, b) => Number(a.dataset.itemIndex) - Number(b.dataset.itemIndex)).at(-1)!;
    const view = scroller.getBoundingClientRect();
    const box = last.getBoundingClientRect();
    return { fits: box.bottom <= view.bottom + 1, gap: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) };
  });
}

for (const width of [1440, 375]) test(`following keeps the growing end fully visible at ${width}px mobile`, async ({ page }) => {
  await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width < 600) await page.getByRole("button", { name: "Agents", exact: true }).click();
  const row = page.getByRole("button", { name: width < 600 ? /Agent 3[0-9]/ : /Agent 2[0-9]/ }).first();
  if (test.info().project.use.hasTouch) {
    await row.scrollIntoViewIfNeeded();
    // Let mobile WebKit finish the sidebar scroll before dispatching a touch.
    await page.waitForTimeout(250);
    await row.tap();
  } else await row.click();
  const message = page.getByLabel("Message", { exact: true });
  await expect(page.locator(".item").first()).toBeVisible();
  await message.fill("grow");
  await page.getByRole("button", { name: /^(Send|Queue)$/ }).click();
  const latest = page.getByRole("button", { name: "Latest ↓" });
  // Sample through the whole turn: the end stays pinned and Latest never shows.
  // A frame may land short while a row grows; it must settle within 250ms.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(80);
    await expect(latest).toHaveCount(0);
    await expect.poll(async () => (await lastRowVisible(page)).gap, { timeout: 250, intervals: [16], message: `end pinned at sample ${i}` }).toBeLessThanOrEqual(2);
  }
  await expect(page.getByText(/grow done/)).toBeVisible();
  await expect.poll(async () => (await lastRowVisible(page)).fits).toBe(true);
  await expect.poll(async () => (await lastRowVisible(page)).gap).toBeLessThanOrEqual(2);
  await expect(latest).toHaveCount(0);
  // A real scroll-up stops following and offers the way back.
  const scroller = page.locator("[data-virtuoso-scroller]");
  if (test.info().project.use.hasTouch) {
    await scroller.dispatchEvent("touchmove");
    await scroller.evaluate((el) => el.scrollBy(0, -600));
  } else {
    await scroller.hover();
    await page.mouse.wheel(0, -600);
  }
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect.poll(async () => (await lastRowVisible(page)).gap).toBeLessThanOrEqual(2);
});

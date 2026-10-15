import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
// A row that Virtuoso unmounts before the toggle event reaches React must still
// remount open: the click records the expansion, not the later event.
test("an expanded tool row stays open after leaving and re-entering the virtual range", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 600 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  // Long enough that the row leaves even Virtuoso's overscan band.
  const row = page.getByRole("button", { name: /Long mixed/ }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(page.locator(".item").first()).toBeVisible();
  const tool = page.locator(".tool summary").filter({ hasText: "grep round-43" });
  await expect
    .poll(async () => {
      if (await tool.isVisible()) return true;
      await scroller.evaluate((el) => el.scrollBy({ top: -el.clientHeight * 0.5, behavior: "instant" }));
      return false;
    })
    .toBe(true);
  // Simulate the toggle event being lost to an unmount: React never sees it.
  await tool.evaluate((summary) => {
    summary.parentElement!.addEventListener("toggle", (e) => e.stopImmediatePropagation(), true);
  });
  await tool.click();
  await expect(tool.locator("xpath=..")).toHaveAttribute("open", "");
  await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect(tool).toHaveCount(0);
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
  await expect
    .poll(async () => {
      if (await tool.count()) return true;
      await scroller.evaluate((el) => el.scrollBy({ top: -el.clientHeight * 0.5, behavior: "instant" }));
      return false;
    })
    .toBe(true);
  await expect(tool.locator("xpath=..")).toHaveAttribute("open", "");
  await expect(page.locator(".tool-body").filter({ hasText: "check passed for round 43" })).toHaveCount(1);
});

import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
// A row that Virtuoso unmounts before the toggle event reaches React must still
// remount open: the click records the expansion, not the later event.
test("an expanded tool row stays open after leaving and re-entering the virtual range", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 600 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Claude Visual review .*Idle/ }).click();
  const scroller = page.locator("[data-virtuoso-scroller]");
  await expect(page.locator(".item").first()).toBeVisible();
  const diff = page.locator(".tool summary").filter({ hasText: "theme.css" });
  await expect
    .poll(async () => {
      if (await diff.isVisible()) return true;
      await scroller.evaluate((el) => el.scrollBy({ top: -el.clientHeight * 0.5, behavior: "instant" }));
      return false;
    })
    .toBe(true);
  // Simulate the toggle event being lost to an unmount: React never sees it.
  await diff.evaluate((summary) => {
    summary.parentElement!.addEventListener("toggle", (e) => e.stopImmediatePropagation(), true);
  });
  await diff.click();
  await expect(diff.locator("xpath=..")).toHaveAttribute("open", "");
  await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect(diff).toHaveCount(0);
  await expect
    .poll(async () => {
      if (await diff.count()) return true;
      await scroller.evaluate((el) => el.scrollBy({ top: el.clientHeight * 0.35, behavior: "instant" }));
      return false;
    })
    .toBe(true);
  await expect(diff.locator("xpath=..")).toHaveAttribute("open", "");
  await expect(page.locator(".code-block.diff")).toHaveCount(1);
});

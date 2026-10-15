import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

// Headless Chromium hides scrollbars; draw the classic, space-taking kind.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("a classic scrollbar keeps the composer on the transcript's column", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium draws classic scrollbars here");
  await page.setViewportSize({ width: 900, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".item").last()).toBeVisible();
  const scroller = page.locator("[data-virtuoso-scroller]");
  expect(await scroller.evaluate((el) => el.offsetWidth - el.clientWidth)).toBeGreaterThan(0);
  const edges = (selector: string) => page.locator(selector).last().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [Math.round(box.left * 2) / 2, Math.round(box.right * 2) / 2];
  });
  await expect.poll(() => edges(".composer")).toEqual(await edges(".item"));
});

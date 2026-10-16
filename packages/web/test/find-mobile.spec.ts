import { test, expect } from "./fixtures.ts";
import { openLong, highlights } from "./find-helpers.ts";

// Phones have no ⌘F: the chat header and the launcher open find, and the bar
// sits above the composer (clear of the keyboard), with 44px targets.
test("mobile: find opens from the header and the launcher, above the composer", async ({ page }) => {
  await openLong(page, 375);
  const tap = async (locator: import("@playwright/test").Locator) => test.info().project.use.hasTouch ? locator.tap() : locator.click();
  await tap(page.getByRole("button", { name: "Find in chat" }));
  const bar = page.getByRole("search", { name: "Find in chat" });
  const input = bar.getByRole("searchbox", { name: "Find in chat" });
  await expect(input).toBeFocused();
  await input.fill("Thinking about round 2.");
  await expect(bar.getByRole("status")).toHaveText("1 of 1");
  await expect.poll(async () => (await highlights(page)).current).toEqual(["Thinking about round 2."]);
  await expect(page.locator('[data-item-id="s-think-2"]')).toBeInViewport();
  const box = (await bar.boundingBox())!;
  const composer = (await page.locator("form.composer").boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
  for (const name of ["Older match", "Newer match", "Close find"]) {
    const b = (await bar.getByRole("button", { name }).boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
  }
  await tap(bar.getByRole("button", { name: "Close find" }));
  await expect(bar).toHaveCount(0);

  await tap(page.getByRole("button", { name: "Open launcher" }).last());
  await tap(page.getByRole("option", { name: /Find in chat/ }));
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
});

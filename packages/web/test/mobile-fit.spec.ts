import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

test.use({ isMobile: true, hasTouch: true });

// Nothing may widen the page: wide content scrolls inside its own box.
async function expectFits(page: Page, view: string) {
  const result = await page.evaluate(() => {
    const scrollers = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if ((o === "auto" || o === "scroll") && p.getBoundingClientRect().right <= innerWidth + 0.5) return true;
      }
      return false;
    };
    const outside = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5) && !scrollers(el);
    }).map((el) => `${el.tagName}.${el.className}`);
    return { scrollWidth: document.scrollingElement!.scrollWidth, width: innerWidth, outside };
  });
  expect(result.scrollWidth, view).toBeLessThanOrEqual(result.width);
  expect(result.outside, view).toEqual([]);
}

for (const viewport of [{ width: 375, height: 812 }, { width: 360, height: 780 }])
  test(`phone layout fits ${viewport.width}px: sidebar, transcript, pending and permission`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const agents = page.getByRole("button", { name: "Agents", exact: true });
    expect((await agents.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await agents.click();
    await expect(page.getByRole("button", { name: /Agent 00/ })).toBeVisible();
    await expectFits(page, "sidebar");
    await page.getByRole("button", { name: /^Schedules on / }).first().click();
    await expect(page.getByRole("region", { name: "Schedules" })).toBeVisible();
    await expectFits(page, "schedules");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Visual review/ }).click();
    // Walk the whole transcript (tools, code, tables, diffs); expand the first tool output on the way.
    const scroller = page.locator("[data-virtuoso-scroller]");
    await expect(page.locator(".item").first()).toBeVisible();
    await expect.poll(async () => {
      await scroller.evaluate((el) => el.scrollTo(0, 0));
      return page.getByRole("heading", { name: "A calmer place to work" }).isVisible();
    }).toBe(true);
    let expanded = false;
    for (let step = 0; step < 40; step++) {
      await page.waitForTimeout(60);
      const tool = page.locator(".tool summary").first();
      const toolBox = !expanded && await tool.isVisible() ? await tool.boundingBox() : null;
      const scrollBox = (await scroller.boundingBox())!;
      if (!expanded && toolBox && toolBox.y >= scrollBox.y && toolBox.y + toolBox.height <= scrollBox.y + scrollBox.height) {
        await tool.click();
        expanded = true;
      }
      await expectFits(page, `transcript step ${step}`);
      if (await scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)) break;
      await scroller.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.7));
    }
    expect(expanded).toBe(true);

    await agents.click();
    const row = page.getByRole("button", { name: /Agent 4\d/ }).first();
    await row.scrollIntoViewIfNeeded();
    // Let mobile WebKit finish the sidebar scroll before dispatching a touch.
    await page.waitForTimeout(250);
    await row.tap();
    await expect(page.locator("main header strong")).toHaveText(/Agent 4\d/);
    await expect(page.locator("aside")).not.toHaveClass("open");
    const message = page.getByLabel("Message");
    expect(await message.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    for (const select of await page.locator(".composer select").all())
      expect(await select.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    // "Queue" while the agent is busy (the second width finds it still waiting).
    const sendButton = page.getByRole("button", { name: /^(Send|Queue)$/ });
    expect((await sendButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await message.fill(`Check ${"/very/long/unbroken/path".repeat(12)} and ${"0123456789abcdef".repeat(6)}`);
    await sendButton.click();
    await expect(page.getByText(/^echo: Check/)).toBeVisible();
    await message.fill("permission");
    await sendButton.click();
    await expect(page.getByText("Permission: Write")).toBeVisible();
    await message.fill(`queued ${"x".repeat(160)}`);
    await sendButton.click();
    await expect(page.locator(".pending-row")).toHaveCount(1);
    await expectFits(page, "permission card and pending strip");
    const box = (await message.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: `/tmp/casm-web-mobile-fit-${viewport.width}.png` });
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByText("Permission: Write")).toBeHidden();
  });

test("composer follows visual viewport resizing and keyboard dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await page.getByLabel("Message").focus();
  // Headless browsers do not show the OS keyboard; exercise its viewport contract.
  for (const height of [480, 812]) {
    await page.evaluate((height) => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: height });
      visualViewport!.dispatchEvent(new Event("resize"));
    }, height);
    await expect.poll(async () => Math.round((await page.locator(".app").boundingBox())!.height)).toBe(height);
    const composer = (await page.locator(".composer").boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(height);
  }
});

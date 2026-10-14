import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

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
    await page.getByLabel("Server token").fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const agents = page.getByRole("button", { name: "Agents", exact: true });
    expect((await agents.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await agents.click();
    await expect(page.getByRole("button", { name: /Agent 00/ })).toBeVisible();
    await expectFits(page, "sidebar");
    await page.getByRole("button", { name: /host menu/ }).click();
    await page.getByRole("menuitem", { name: /Schedules/ }).click();
    await expect(page.getByRole("dialog", { name: /schedules/ })).toBeVisible();
    await expectFits(page, "host menu");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Visual review/ }).click();
    // Walk the whole transcript (tools, code, tables, diffs); expand the first tool output on the way.
    const scroller = page.locator("[data-virtuoso-scroller]");
    await expect(page.locator(".item").first()).toBeVisible();
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    let expanded = false;
    for (let step = 0; step < 40; step++) {
      await page.waitForTimeout(60);
      const tool = page.locator(".tool summary").first();
      if (!expanded && await tool.isVisible()) {
        await tool.click();
        expanded = true;
      }
      await expectFits(page, `transcript step ${step}`);
      if (await scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)) break;
      await scroller.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.7));
    }
    expect(expanded).toBe(true);

    await agents.click();
    await page.getByRole("button", { name: /Agent 4\d/ }).first().click();
    const message = page.getByLabel("Message");
    expect(await message.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    for (const select of await page.locator(".composer select").all())
      expect(await select.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    const sendButton = page.getByRole("button", { name: "Send", exact: true });
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

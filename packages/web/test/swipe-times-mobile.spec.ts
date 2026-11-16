import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// Real touch gestures (native scrolling included) need CDP: Chromium only.
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, timezoneId: "UTC" });
test.skip(({ browserName }) => browserName !== "chromium", "touch gestures go through CDP");

async function open(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".item").last()).toBeVisible();
  await settled(page);
  return page.context().newCDPSession(page);
}
// Touch events go to the touched node; one Virtuoso replaces while the
// transcript settles would take the rest of the gesture with it.
async function settled(page: Page) {
  const rows = () => page.locator("[data-virtuoso-scroller]").evaluate(async (el) => {
    const mark = el.querySelectorAll("[data-index]");
    await new Promise((done) => setTimeout(done, 300));
    const now = el.querySelectorAll("[data-index]");
    return mark.length === now.length && [...mark].every((m, i) => m === now[i]);
  });
  await expect.poll(rows).toBe(true);
}

type Point = { x: number; y: number };
/** Press at `from`, move to `to` in steps, run `during` before lifting. */
async function swipe(cdp: CDPSession, from: Point, to: Point, during?: () => Promise<void>, steps = 12) {
  const at = (p: Point) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(p) });
  }
  await during?.();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const box = (page: Page) => page.locator(".transcript-box");

test("a horizontal swipe at 375 reveals entry times in a left gutter, then springs back", async ({ page }, info) => {
  const cdp = await open(page);
  const entry = page.locator(".entry:has(> .item.assistant)").last();
  const time = entry.locator(".entry-time");
  await expect(time).toBeHidden();
  const rest = (await entry.locator(".item").boundingBox())!;
  await page.screenshot({ path: info.outputPath("before.png") });

  await swipe(cdp, { x: 120, y: 400 }, { x: 260, y: 410 }, async () => {
    await expect(box(page)).toHaveAttribute("data-times", "drag");
    // Same text as the desktop gutter; history before today shows its date above.
    await expect(time).toBeVisible();
    await expect(time).toHaveText(/^14 Oct( 2026)?11:16:43$/);
    const item = (await entry.locator(".item").boundingBox())!;
    const t = (await time.boundingBox())!;
    // The rows slid right by about the gutter, never further.
    expect(item.x - rest.x).toBeGreaterThan(60);
    expect(item.x - rest.x).toBeLessThanOrEqual(72.5);
    // The time sits wholly on screen, left of the column, level with the role label.
    expect(t.x).toBeGreaterThanOrEqual(8);
    expect(item.x - (t.x + t.width)).toBeGreaterThan(8);
    const role = (await entry.locator(".message-role").boundingBox())!;
    expect(Math.abs(t.y + t.height / 2 - (role.y + role.height / 2))).toBeLessThan(2.5);
    expect(Number(await time.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.95);
    // Every visible entry shows its own time.
    const shown = await page.locator(".entry .entry-time").evaluateAll((els) => els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).display !== "none";
    }).length);
    expect(shown).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: info.outputPath("after.png") });
  });
  await expect(box(page)).not.toHaveAttribute("data-times");
  await expect(time).toBeHidden();
  expect((await entry.locator(".item").boundingBox())!.x).toBeCloseTo(rest.x, 0);
});

test("a vertical swipe at 375 scrolls without revealing times", async ({ page }) => {
  const cdp = await open(page);
  const scroller = page.locator("[data-virtuoso-scroller]");
  const top = await scroller.evaluate((el) => el.scrollTop);
  let revealed = false;
  // Slightly diagonal, as a thumb moves.
  await swipe(cdp, { x: 150, y: 300 }, { x: 175, y: 600 }, async () => {
    revealed = (await box(page).getAttribute("data-times")) !== null;
  });
  expect(revealed).toBe(false);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(top - 100);
});

test("a swipe starting at the left screen edge at 375 is left to the system", async ({ page }) => {
  const cdp = await open(page);
  let revealed = true;
  await swipe(cdp, { x: 10, y: 400 }, { x: 200, y: 405 }, async () => {
    revealed = (await box(page).getAttribute("data-times")) !== null;
  });
  expect(revealed).toBe(false);
});

test("a scrolled code block at 375 keeps its horizontal swipe", async ({ page }) => {
  const cdp = await open(page);
  await page.getByLabel("Message").fill("wide\n\n```\n" + "const x = 1; ".repeat(30) + "\n```");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const pre = page.locator(".entry", { hasText: "echo: wide" }).locator("pre").last();
  await expect(pre).toBeVisible();
  await settled(page);
  expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const b = (await pre.boundingBox())!;
  const y = b.y + b.height / 2;
  // Left: the code scrolls (and no times, it's not a rightward swipe).
  let revealed = false;
  await swipe(cdp, { x: 300, y }, { x: 80, y }, async () => {
    revealed ||= (await box(page).getAttribute("data-times")) !== null;
  });
  await expect.poll(() => pre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
  const scrolled = await pre.evaluate((el) => el.scrollLeft);
  // Right, while it can still scroll back: the code scrolls, the rows stay.
  await swipe(cdp, { x: 80, y }, { x: 200, y }, async () => {
    revealed ||= (await box(page).getAttribute("data-times")) !== null;
  });
  await expect.poll(() => pre.evaluate((el) => el.scrollLeft)).toBeLessThan(scrolled - 50);
  expect(revealed).toBe(false);
});

test("reduced motion at 375 shows the times without sliding gradually", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cdp = await open(page);
  const item = page.locator(".entry:has(> .item.assistant)").last().locator(".item");
  const rest = (await item.boundingBox())!;
  // A short swipe already shows the full gutter.
  await swipe(cdp, { x: 120, y: 400 }, { x: 150, y: 402 }, async () => {
    expect((await item.boundingBox())!.x - rest.x).toBeCloseTo(72, 0);
    await expect(page.locator(".entry:has(> .item.assistant)").last().locator(".entry-time")).toBeVisible();
  }, 4);
  // And it's gone at once on release.
  await expect(box(page)).not.toHaveAttribute("data-times");
  expect((await item.boundingBox())!.x).toBeCloseTo(rest.x, 0);
});

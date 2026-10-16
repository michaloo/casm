import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// History entries are dated 2026-10-14 08:00 UTC onwards, 37s apart.
test.use({ timezoneId: "UTC" });

async function open(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (page.viewportSize()!.width < 600) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".item").last()).toBeVisible();
}
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

for (const scheme of ["light", "dark"] as const) {
  test(`entry times sit in the left gutter on hover and focus at 1440 ${scheme}`, async ({ page, isMobile }, info) => {
    test.skip(isMobile, "touch has no hover");
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    const entry = page.locator(".entry:has(> .item.assistant)").last();
    const time = entry.locator(".entry-time");
    // Message 319: 08:00:00 + 319 × 37s.
    await expect(time).toHaveText(/^14 Oct( 2026)?11:16:43$/);
    await expect(time).toHaveCSS("opacity", "0");
    const before = await entry.boundingBox();
    await entry.hover();
    await expect(time).toHaveCSS("opacity", "1");
    // No layout shift; right-aligned against the column, level with the first line.
    expect(await entry.boundingBox()).toEqual(before);
    const t = (await time.boundingBox())!;
    const item = (await entry.locator(".item").boundingBox())!;
    const role = (await entry.locator(".message-role").boundingBox())!;
    expect(item.x - (t.x + t.width)).toBeGreaterThan(8);
    expect(item.x - (t.x + t.width)).toBeLessThan(20);
    expect(Math.abs(t.y + t.height / 2 - (role.y + role.height / 2))).toBeLessThan(2.5);
    await expect(time).toHaveCSS("font-variant-numeric", "tabular-nums");
    // Not today: the date just above the time, and the full date in the tooltip.
    await expect(time).toHaveAttribute("title", "Wed 14 Oct 2026, 11:16:43");
    const date = time.locator(".entry-date");
    await expect(date).toHaveText(new Date().getFullYear() === 2026 ? "14 Oct" : "14 Oct 2026");
    const d = (await date.boundingBox())!;
    expect(d.y + d.height).toBeLessThanOrEqual(t.y + 1);
    expect(Math.abs(d.x + d.width - (t.x + t.width))).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath(`hover-${scheme}.png`) });
    await page.screenshot({ path: `/tmp/cb-shots/entry-hover-${scheme}.png` });

    // A user message: level with its role label inside the bubble.
    const user = page.locator(".entry:has(> .item.user)").last();
    await user.hover();
    const u = (await user.locator(".entry-time").boundingBox())!;
    const label = (await user.locator(".message-role").boundingBox())!;
    expect(Math.abs(u.y + u.height / 2 - (label.y + label.height / 2))).toBeLessThan(2.5);

    // A live reply is stamped by the server: today, so no tooltip.
    await page.getByLabel("Message").fill("hello");
    await page.getByLabel("Message").press("Enter");
    const reply = page.locator(".entry", { hasText: "echo: hello" });
    await expect(reply).toBeVisible();
    const stamp = reply.locator(".entry-time");
    await expect(stamp).toHaveText(/^\d\d:\d\d:\d\d$/);
    expect(await stamp.getAttribute("title")).toBeNull();

    // Keyboard focus inside an entry shows it too.
    await page.mouse.move(5, 5);
    await expect(stamp).toHaveCSS("opacity", "0");
    await reply.locator(".item").evaluate((el) => { el.tabIndex = -1; el.focus(); });
    await expect(stamp).toHaveCSS("opacity", "1");
  });
}

test("a narrow window puts the time inside the column, top right", async ({ page, isMobile }, info) => {
  test.skip(isMobile, "touch has no hover");
  await page.setViewportSize({ width: 860, height: 800 });
  await open(page);
  await expect(page.locator(".chat")).toHaveAttribute("data-gutter", "narrow");
  const entry = page.locator(".entry:has(> .item.assistant)").last();
  await entry.hover();
  const t = (await entry.locator(".entry-time").boundingBox())!;
  const item = (await entry.locator(".item").boundingBox())!;
  expect(Math.abs(t.x + t.width - (item.x + item.width))).toBeLessThan(1);
  expect(t.y).toBeGreaterThanOrEqual(item.y);
  // Above the role label, never over the text.
  expect(t.y + t.height).toBeLessThanOrEqual((await entry.locator(".message-role").boundingBox())!.y + 1);
  await page.screenshot({ path: `/tmp/cb-shots/entry-narrow.png` });
  await page.screenshot({ path: info.outputPath("narrow.png") });
});

test("tool rows show start, finish and duration; touch hides entry times at 375", async ({ page, isMobile }) => {
  await page.setViewportSize({ width: isMobile ? 375 : 1440, height: 812 });
  await open(page);
  await page.getByLabel("Message").fill("grow");
  if (isMobile) await page.getByRole("button", { name: "Send", exact: true }).click();
  else await page.getByLabel("Message").press("Enter");
  await expect(page.getByText("grow done")).toBeVisible();
  if (isMobile) {
    // No hover on touch: the time stays out of the way.
    const last = page.locator(".entry").last();
    await expect(last.locator(".entry-time")).toHaveCount(1);
    await expect(last.locator(".entry-time")).toBeHidden();
    await page.screenshot({ path: `/tmp/cb-shots/entry-375.png` });
    return;
  }
  const tool = page.locator(".entry:has(> .item.tool)").last();
  const time = tool.locator(".entry-time");
  await expect(time).toHaveAttribute("title", /^started \d\d:\d\d:\d\d · finished \d\d:\d\d:\d\d · took \d+s$/);
  await tool.hover();
  await expect(time).toHaveCSS("opacity", "1");
  await page.screenshot({ path: `/tmp/cb-shots/entry-tool-1440.png` });
});

test("permission cards are dated in the same gutter", async ({ page, isMobile }) => {
  test.skip(isMobile, "touch has no hover");
  await open(page);
  await page.getByLabel("Message").fill("permission");
  await page.getByLabel("Message").press("Enter");
  const entry = page.locator(".entry:has(> .card)");
  await entry.hover();
  const time = entry.locator(".entry-time");
  await expect(time).toHaveText(/^\d\d:\d\d:\d\d$/);
  await expect(time).toHaveCSS("opacity", "1");
  const t = (await time.boundingBox())!;
  const card = (await entry.locator(".card").boundingBox())!;
  const title = (await entry.locator(".card > strong").boundingBox())!;
  expect(card.x - (t.x + t.width)).toBeGreaterThan(8);
  expect(Math.abs(t.y + t.height / 2 - (title.y + title.height / 2))).toBeLessThan(3);
  await page.screenshot({ path: `/tmp/cb-shots/entry-card.png` });
});

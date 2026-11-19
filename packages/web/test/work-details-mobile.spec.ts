import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";
import { openLong, highlights } from "./find-helpers.ts";

test.use({ workView: "compact" });
async function login(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
}
for (const width of [1440, 375]) {
  test(`mobile work details at ${width}: conversation first, expand on demand and remember device preference`, async ({ page }) => {
    await login(page, width);
    const agent = page.getByRole("button", { name: /Visual review/ }).first();
    await agent.scrollIntoViewIfNeeded(); await agent.click();
    const group = page.locator(".work-details").first();
    await expect(group.locator("summary").first()).toContainText("6 activities");
    await expect(group.locator("summary").first()).toContainText("1 failed");
    await expect(group.locator("summary").first()).toContainText("Running");
    await expect(page.locator(".item.tool")).toHaveCount(0);
    await expect(page.getByText("A calmer place to work")).toBeVisible();
    await group.locator("summary").first().click();
    await expect(group.locator(".item.tool")).toHaveCount(4);
    const bash = group.locator(".item.tool").first();
    await bash.locator("summary").click();
    await expect(bash.locator(".tool-body")).toBeVisible();
    await group.locator("summary").first().click();
    await expect(page.locator(".item.tool")).toHaveCount(0);
    await group.locator("summary").first().click();
    await expect(bash.locator(".tool-body")).toBeVisible();
    await group.locator("summary").first().click();
    await page.screenshot({ path: test.info().outputPath(`compact-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (width === 375) await openAgents(page);
    await page.getByRole("button", { name: "This device", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "This device" });
    await expect(dialog.getByRole("radio", { name: /Grouped/ })).toBeChecked();
    await dialog.getByRole("radio", { name: /Individual/ }).check();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".work-details")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("casm.work-view"))).toBe("detailed");
    await page.reload();
    if (width === 375) await openAgents(page);
    await page.getByRole("button", { name: "This device", exact: true }).click();
    await expect(page.getByRole("radio", { name: /Individual/ })).toBeChecked();
  });

  test(`mobile live work at ${width} stays compact and leaves permissions visible`, async ({ page }) => {
    await login(page, width);
    await page.getByRole("button", { name: /Agent 00/ }).first().click();
    const message = page.getByLabel("Message", { exact: true });
    await expect(page.locator(".item").last()).toBeVisible();
    await message.fill("grow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".work-details").last()).toBeVisible();
    await expect(page.locator(".item.tool")).toHaveCount(0);
    await expect(page.getByText(/grow done/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Latest/ })).toHaveCount(0);
    await expect.poll(() => page.locator("[data-virtuoso-scroller]").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))).toBeLessThanOrEqual(2);
    await message.fill("permission");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Permission: Write")).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByText("echo: permission", { exact: true })).toBeVisible();
  });

  test(`mobile find at ${width} opens grouped tools and older thinking, then returns to latest`, async ({ page }) => {
    await openLong(page, width);
    await page.getByRole("button", { name: "Find in chat", exact: true }).click();
    const input = page.getByRole("searchbox", { name: "Find in chat" });
    await input.fill('round-30"');
    const tool = page.locator('[data-item-id="s-bash-30"]');
    await expect(tool.locator("details")).toHaveAttribute("open", "");
    await expect.poll(async () => (await highlights(page)).current).toEqual(['round-30"']);
    await input.fill("Thinking about round 2.");
    await expect(page.locator('[data-item-id="s-think-2"] details')).toHaveAttribute("open", "");
    await expect.poll(async () => (await highlights(page)).current).toEqual(["Thinking about round 2."]);
    await page.getByRole("button", { name: "Close find" }).click();
    await page.getByRole("button", { name: /Latest/ }).click();
    await expect(page.getByText("Round 44").first()).toBeInViewport();
  });
}

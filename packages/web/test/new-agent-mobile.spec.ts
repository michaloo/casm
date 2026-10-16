import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect, openNewAgent } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// The new-agent screen: a centered welcome, the composer near the middle, the keys below.
for (const width of [1440, 375]) test(`new-agent screen welcomes, starts and settles at ${width}px`, async ({ page }) => {
  const height = width === 375 ? 812 : 900;
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await openNewAgent(page);
  const main = page.locator("main.chat");
  const welcome = main.locator(".start-welcome");
  await expect(welcome.getByRole("heading", { name: "Test project" })).toBeVisible();
  await expect(welcome.locator(".start-glyph")).toBeVisible();
  await expect(welcome.locator("code")).toHaveText(testHome);
  await expect(welcome.locator(".start-host")).toHaveText("Test host");
  await expect(main).not.toContainText("Start a conversation");
  const message = page.getByLabel("Message");
  await expect(message).toHaveAttribute("placeholder", "What should the agent do in Test project?");

  // The composer sits near the middle while the chat is empty.
  const composer = main.locator("form.composer");
  const box = (await composer.boundingBox())!;
  const center = box.y + box.height / 2;
  expect(center).toBeGreaterThan(height * 0.35);
  expect(center).toBeLessThan(height * 0.72);
  expect((await welcome.boundingBox())!.y + 10).toBeLessThan(box.y);

  // Calm: no starter chips or recent agents, only the keys.
  await expect(main.getByRole("group")).toHaveCount(0);
  const keys = main.locator(".start-keys");
  if (width === 1440) {
    await expect(keys).toContainText("Enter send");
    await expect(keys).toContainText("/ commands");
    await expect(keys).toContainText(/(⌘|Ctrl)K launcher/);
  } else await expect(keys).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: test.info().outputPath(`new-agent-${scheme}-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });

  // Once the conversation starts, the composer settles at the bottom.
  await message.fill("Hello from the start screen");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/a\//);
  await expect(main.locator(".start-welcome")).toHaveCount(0);
  await expect(main.locator(".start-extras")).toHaveCount(0);
  await expect(message).toHaveAttribute("placeholder", "Message agent…");
  const settled = (await composer.boundingBox())!;
  expect(settled.y + settled.height).toBeGreaterThan(height - 60);
});

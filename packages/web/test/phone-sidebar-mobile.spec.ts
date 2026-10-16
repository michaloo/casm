import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

async function login(page: any, path = "/") {
  await page.goto(path);
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

test("phone at 375px opens on the sidebar, and Close appears only with a chat behind it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const nav = page.getByRole("navigation", { name: "Agents" });
  const close = page.getByRole("button", { name: "Close", exact: true });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent 00/ })).toBeVisible();
  await expect(close).toHaveCount(0);

  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(nav).toBeHidden();
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  const chatPath = new URL(page.url()).pathname;
  expect(chatPath).toMatch(/^\/h\/.+\/a\/.+/);

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(close).toBeVisible();
  await close.click();
  await expect(nav).toBeHidden();

  await page.goto(chatPath);
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await expect(nav).toBeHidden();
});

import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

for (const width of [1440, 375]) test(`host row opens the host modal at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  // The header only folds; ⋯ opens the host modal, + a new project. Status stays off the row, in its tooltip.
  const fold = page.getByRole("button", { name: "Toggle Test host host", exact: true });
  await expect(fold.locator(".host-dot.online")).toHaveCount(1);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(fold).toHaveAccessibleDescription(/Online/);
  const trigger = page.getByRole("button", { name: "Host options for Test host", exact: true });
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  const plus = page.getByRole("button", { name: "New project on Test host", exact: true });
  await expect(plus).toHaveAttribute("title", "New project");
  await expect(fold).toHaveAttribute("title", "Test host · Online");
  await expect(fold.locator("small")).toHaveCount(0);
  await expect(page.locator("nav .host-heading").first().getByRole("button")).toHaveCount(3);
  if (width === 375) for (const button of [trigger, plus]) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await trigger.focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).pathname).toBe("/");
  const host = page.getByRole("dialog", { name: "Test host host" });
  await expect(host).toBeVisible();
  const tabs = host.getByRole("navigation");
  await expect(tabs.getByRole("button")).toHaveText(["Usage", "AGENTS.md", "System Prompt", "Notifications"]);
  await expect(tabs.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-pressed", "true");
  if (width === 375) {
    const box = (await host.boundingBox())!;
    expect([box.x, box.width, box.height]).toEqual([0, 375, 812]);
  }
  await page.keyboard.press("Escape");
  await expect(host).toBeHidden();
  await expect(trigger).toBeFocused();
});

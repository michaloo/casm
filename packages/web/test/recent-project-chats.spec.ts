import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

test("projects start with their five most recent chats and can show the rest", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(testHome + "/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const project = page.locator(".project-group").filter({ has: page.getByRole("button", { name: "Toggle Test project" }) });
  await expect(project.locator(".agent")).toHaveCount(5);
  await expect(project.getByRole("button", { name: /Agent 17/ })).toHaveCount(0);
  await project.getByRole("button", { name: /Show \d+ more chats/ }).click();
  const older = project.getByRole("button", { name: /Agent 17/ });
  await older.click();
  await expect(page.locator("main header strong")).toHaveText("Agent 17");
  await project.getByRole("button", { name: "Show recent chats" }).click();
  await expect(project.locator(".agent")).toHaveCount(6);
  await expect(older).toHaveAttribute("aria-current", "page");
});

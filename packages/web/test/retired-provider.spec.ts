import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

test("an agent of a removed provider opens read-only with the reason", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const id = readFileSync(`${testHome}/web-retired-id`, "utf8");
  await page.goto(`/h/Test%20host/a/${id}`);
  await expect(page.locator("main").getByRole("status").filter({ hasText: "OpenCode support removed; see the opencode branch" })).toBeVisible();
  await expect(page.locator(".item").filter({ hasText: "history is unavailable" })).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "OpenCode (removed)" }).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

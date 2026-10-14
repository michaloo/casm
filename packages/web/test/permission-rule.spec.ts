import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

test("permission card shows the rule Always saves and sends the edited pattern", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 03/ }).click();
  await page.getByLabel("Message").fill("rule permission");
  await page.getByLabel("Message").press("Enter");
  const card = page.locator(".pending .card").filter({ hasText: "Permission: bash" });
  await expect(card).toContainText("npm test -- -w && git status");
  await expect(card).toContainText("Commands to always allow");
  await expect(card).toContainText("Saved in /project/.pi/settings.json");
  const rule = card.getByLabel("Rule to always allow");
  await expect(rule).toHaveValue("npm test *\ngit status");
  await rule.fill("");
  await expect(card.getByRole("button", { name: "Always allow" })).toBeDisabled();
  await rule.fill("npm test *\ngit status *");
  await card.getByRole("button", { name: "Always allow" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".item").filter({ hasText: 'Answer: allowAlways "npm test *\\ngit status *"' })).toBeVisible();
});

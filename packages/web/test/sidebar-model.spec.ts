import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("compact provider/model rows and remembered collapse preserve routed agent visibility", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const row = page.getByRole("button", { name: /Agent 00/ });
  await row.click();
  const agentRoute = page.url();
  await expect(row.locator(".provider-icon")).toHaveAttribute("aria-label", "Claude");
  await expect(row.locator(".agent-model")).toContainText("Model unresolved");
  await expect(page.getByLabel("Model").locator("option:checked")).toHaveText("Default · unresolved");
  const toggle = page.getByRole("button", { name: "Toggle Test project", exact: true });
  await expect(toggle).toBeDisabled();
  await page.getByRole("button", { name: "Test project ＋", exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  const saved = await page.evaluate(() => localStorage.getItem("casm.collapsed-projects"));
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.goto(agentRoute);
  await expect(row).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => localStorage.getItem("casm.collapsed-projects"))).toBe(saved);
});

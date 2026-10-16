import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

export async function openLong(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width < 600) await openAgents(page);
  const row = page.getByRole("button", { name: /Long mixed/ }).first();
  await row.scrollIntoViewIfNeeded();
  if (test.info().project.use.hasTouch) {
    await page.waitForTimeout(250);
    await row.tap();
  } else await row.click();
  await expect(page.getByText("Round 44").first()).toBeVisible();
}

// The text of the strong highlight, and how many subtle ones there are.
export function highlights(page: Page) {
  return page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const current = [...(registry.get("casm-find-current") ?? [])];
    return { current: current.map((r) => r.toString()), others: registry.get("casm-find")?.size ?? 0 };
  });
}


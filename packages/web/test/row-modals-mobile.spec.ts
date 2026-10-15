// Host and project rows open one shared modal layout from their ⋯ button: no
// dropdown menus. + on the host row adds a project.
import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

async function sheetFits(dialog: Locator, width: number) {
  const box = (await dialog.boundingBox())!;
  if (width < 600) expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 375, 812]);
  else expect(box.width).toBeLessThan(width);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

for (const width of [1440, 375]) test(`host and project modals open from ⋯ at ${width} mobile`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Agents" });

  // Host: ⋯ opens the modal straight on Usage; tabs are Usage · Schedules · Instructions.
  const hostOptions = nav.getByRole("button", { name: "Host options for Test host", exact: true });
  await hostOptions.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  const host = page.getByRole("dialog", { name: "Test host host" });
  await expect(host).toBeVisible();
  const hostTabs = host.getByRole("navigation").getByRole("button");
  await expect(hostTabs).toHaveText(["Usage", "Schedules", "Instructions", "Notifications"]);
  await expect(host.getByRole("region", { name: "Usage" })).toBeVisible();
  await sheetFits(host, width);
  await hostTabs.filter({ hasText: "Schedules" }).click();
  await expect(host.getByRole("region", { name: "Schedules" }).getByRole("button", { name: "New schedule" })).toBeVisible();
  await hostTabs.filter({ hasText: "Instructions" }).click();
  await expect(host.getByRole("heading", { name: "Global agent instructions" })).toBeVisible();
  await expect(host.getByRole("heading", { name: "Agent prompt", exact: true })).toBeVisible();
  await expect(host.getByRole("button", { name: "Memories", exact: true })).toHaveCount(0);
  if (width === 375) for (const tab of await hostTabs.all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sheetFits(host, width);
  await page.keyboard.press("Escape");
  await expect(host).toBeHidden();
  await expect(hostOptions).toBeFocused();

  // Project: ⋯ opens the same layout with AGENTS.md · Memories, the path under its title; no Info or Files.
  const projectOptions = nav.getByRole("button", { name: "Project options for Test project", exact: true });
  await projectOptions.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  const project = page.getByRole("dialog", { name: "Test project project" });
  const projectTabs = project.getByRole("navigation").getByRole("button");
  await expect(projectTabs).toHaveText(["AGENTS.md", "Memories"]);
  await expect(project.getByRole("region", { name: "Project instructions" })).toBeVisible();
  await projectTabs.filter({ hasText: "Memories" }).click();
  await expect(project.locator("summary").filter({ hasText: "Project workflow" })).toBeVisible();
  await expect(project.locator("details.memory-project")).toHaveCount(0);
  await expect(project.locator(".settings-context .middle-path")).toHaveAttribute("title", testHome);
  await expect(project.getByRole("button", { name: "New agent", exact: true })).toBeEnabled();
  // Same shell for both: tab rail on desktop, scrolling tabs on phones.
  const rail = await project.getByRole("navigation").evaluate((el) => getComputedStyle(el).flexDirection);
  expect(rail).toBe(width < 600 ? "row" : "column");
  await sheetFits(project, width);
  await project.getByRole("button", { name: "Close project options" }).click();
  await expect(project).toBeHidden();
  await expect(projectOptions).toBeFocused();

  // + on the host row is New project; ⋯ always means options.
  const plus = nav.getByRole("button", { name: "New project on Test host", exact: true });
  const [plusBox, moreBox] = [(await plus.boundingBox())!, (await hostOptions.boundingBox())!];
  expect(plusBox.width).toBe(moreBox.width);
  expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(moreBox.x + 1);
  await plus.click();
  const create = page.getByRole("dialog", { name: "New project on Test host", exact: true });
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toBeHidden();
  await expect(plus).toBeFocused();
  await page.screenshot({ path: test.info().outputPath(`row-modals-${width}.png`) });
});

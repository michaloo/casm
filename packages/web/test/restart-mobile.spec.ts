import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) test(`/restart marks the old session and leaves other composers alone at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async (name: string) => {
    if (width === 375) await openAgents(page);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.locator(".item.user").last()).toBeVisible();
  };
  const composer = page.locator("form.composer");
  const input = page.getByLabel("Message", { exact: true });
  const list = page.getByRole("listbox", { name: "Slash commands" });
  const divider = page.getByRole("separator").filter({ hasText: "Session restarted" });
  const look = () => composer.evaluate((el) => ({
    parts: [...el.children].map((c) => `${c.tagName}.${c.className}: ${c.textContent}`),
    height: el.getBoundingClientRect().height,
  }));
  // What another agent's composer looks like before any command ran.
  await open("Agent 02");
  const other = await look();

  await open("Agent 03");
  await input.fill("/restart");
  await list.getByRole("option").filter({ hasText: "casm action" }).click();
  await expect(input).toHaveValue("");
  await expect(divider).toBeVisible();
  // The old session stays readable, dimmed as out of the agent's context.
  await expect(page.locator(".entry.earlier").first()).toBeVisible();
  await expect(composer.locator(".command-notice")).toHaveCount(0);
  await page.screenshot({ path: `/tmp/casm-restart-${width}-${test.info().project.name}.png` });

  // Another command's outcome lands in its own agent's transcript, not the composer.
  await input.fill("/reload");
  await list.getByRole("option").filter({ hasText: "casm action" }).click();
  await expect(page.locator(".transcript").getByText("/reload completed")).toBeVisible();
  await expect(composer.getByText("/reload completed")).toHaveCount(0);

  await open("Agent 02");
  await expect(page.locator(".transcript").getByText("/reload completed")).toHaveCount(0);
  await expect(divider).toHaveCount(0);
  await expect(page.locator(".entry.earlier")).toHaveCount(0);
  expect(await look()).toEqual(other);

  // After a reload the history still has the divider, not the old session as current.
  await page.reload();
  await open("Agent 03");
  await expect(divider).toBeAttached();
  await expect(composer.locator(".command-notice")).toHaveCount(0);
});

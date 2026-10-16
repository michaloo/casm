import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { openLong, highlights } from "./find-helpers.ts";
import { scrollItems } from "./scroll-fixture.ts";
import { findInItems } from "../../server/src/find.ts";

// Find in chat searches the agent's whole history on the server: matches in
// pages the client has not loaded, and in collapsed rows, are found and shown.
const shots = "/home/michaloo/Explorations/screenshots";
const items = scrollItems();
const total = (query: string, kinds?: Parameters<typeof findInItems>[2]["kinds"]) => findInItems(items, query, { kinds }).total;

const bar = (page: Page) => page.getByRole("search", { name: "Find in chat" });
const count = (page: Page) => bar(page).getByRole("status");

test("Ctrl+F finds in the whole history: steps with Enter, jumps to an unloaded match, Escape returns focus", async ({ page }) => {
  await openLong(page);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.click();
  await page.keyboard.press("Control+f");
  const input = bar(page).getByRole("searchbox", { name: "Find in chat" });
  await expect(input).toBeFocused();
  await input.fill("Round 4");
  // Smart case: "round 4" in code blocks does not count.
  const all = total("Round 4");
  expect(all).toBeLessThan(total("round 4"));
  await expect(count(page)).toHaveText(`${all} of ${all}`);
  await expect.poll(async () => (await highlights(page)).current).toEqual(["Round 4"]);
  await input.press("Enter");
  await expect(count(page)).toHaveText(`${all - 1} of ${all}`);
  await input.press("Shift+Enter");
  await expect(count(page)).toHaveText(`${all} of ${all}`);
  await bar(page).getByRole("button", { name: "Older match" }).click();
  await expect(count(page)).toHaveText(`${all - 1} of ${all}`);

  // Round 2's Thinking is long before the loaded pages: its window loads and the row opens.
  await input.fill("Thinking about round 2.");
  await expect(count(page)).toHaveText("1 of 1");
  const thinking = page.locator('[data-item-id="s-think-2"]');
  await expect(thinking.locator("details")).toHaveAttribute("open", "");
  await expect.poll(async () => (await highlights(page)).current).toEqual(["Thinking about round 2."]);
  await expect(thinking).toBeInViewport();
  await expect(page.getByText("Round 44")).toHaveCount(0);
  // Not following the end while reading there; Latest goes back to it.
  const latest = page.getByRole("button", { name: "Latest ↓" });
  await expect(latest).toBeVisible();
  await page.screenshot({ path: `${shots}/find-desktop-light.png` });

  await input.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect.poll(async () => (await highlights(page)).current).toEqual([]);
  await latest.click();
  await expect(page.getByText("Round 44").first()).toBeInViewport();
});

test("a match inside a tool's input opens the tool; the filter keeps one kind", async ({ page }) => {
  await openLong(page);
  await page.keyboard.press("Control+f");
  const input = bar(page).getByRole("searchbox", { name: "Find in chat" });
  // Only the input's JSON has the closing quote: the summary line does not count.
  await input.fill('round-30"');
  await expect(count(page)).toHaveText("1 of 1");
  const tool = page.locator('[data-item-id="s-bash-30"]');
  await expect(tool.locator("details")).toHaveAttribute("open", "");
  await expect.poll(async () => (await highlights(page)).current).toEqual(['round-30"']);

  await input.fill("round 2");
  const thinking = total("round 2", ["reasoning"]);
  await expect(count(page)).toHaveText(`${total("round 2")} of ${total("round 2")}`);
  await bar(page).getByRole("combobox", { name: "Search in" }).selectOption("thinking");
  await expect(count(page)).toHaveText(`${thinking} of ${thinking}`);
  await input.fill("no such text anywhere");
  await expect(count(page)).toHaveText("No matches");
  await bar(page).getByRole("button", { name: "Close find" }).click();
  await expect(bar(page)).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const)
  test(`find bar and highlights at 1440 and 375, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const phone = !!test.info().project.use.isMobile;
    await openLong(page, phone ? 375 : 1440);
    if (phone) await page.getByRole("button", { name: "Find in chat" }).tap();
    else await page.keyboard.press("Control+f");
    const input = bar(page).getByRole("searchbox", { name: "Find in chat" });
    await input.fill("layout");
    await expect(count(page)).toHaveText(new RegExp(`of ${total("layout")}$`));
    await expect.poll(async () => (await highlights(page)).others).toBeGreaterThan(1);
    await input.press("Enter");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/find-${phone ? "375" : "1440"}-${scheme}.png` });
  });

test("a window of older history pages newer until it joins the live end", async ({ page }) => {
  await openLong(page);
  await page.keyboard.press("Control+f");
  await bar(page).getByRole("searchbox", { name: "Find in chat" }).fill("Thinking about round 2.");
  await expect(count(page)).toHaveText("1 of 1");
  await expect(page.locator('[data-item-id="s-think-2"]')).toBeInViewport();
  const newer = page.getByRole("button", { name: "Load newer messages" });
  for (let i = 0; i < 10 && await newer.count(); i++) {
    await newer.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  await expect(newer).toHaveCount(0);
  // Joined with the live rows: the end is the live end again.
  await page.locator("[data-virtuoso-scroller]").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.locator('[data-item-id="s-reply-44"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Latest ↓" })).toHaveCount(0);
});

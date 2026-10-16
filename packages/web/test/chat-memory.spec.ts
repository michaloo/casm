import { readFileSync } from "node:fs";
import { testHome } from "./config.ts";
import { test, expect } from "./fixtures.ts";

test.use({ scenario: "memory" });

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}
async function open(page: import("@playwright/test").Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`${name}\\b`) }).first().click();
  await expect(page.locator("main header strong")).toHaveText(name);
  await expect(page.locator(".item").first()).toBeVisible();
}

test("switching through many heavy chats keeps heap, DOM and listeners bounded", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP counters");
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("casm.chat-memory", "5"));
  await login(page);
  const cdp = await page.context().newCDPSession(page);
  const counters = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const dom = await cdp.send("Memory.getDOMCounters");
    return { heap: metrics.find((m) => m.name === "JSHeapUsedSize")!.value / 2 ** 20, nodes: dom.nodes, listeners: dom.jsEventListeners };
  };
  await cdp.send("Performance.enable");
  // Every chat has screenshots in tool results and messages, and big tool output;
  // the long ones (00, 05, 10…) read three older pages.
  const names = Array.from({ length: 16 }, (_, i) => `Mem ${String(i).padStart(2, "0")}`);
  let warm = { heap: 0, nodes: 0, listeners: 0 };
  for (const [i, name] of names.entries()) {
    await open(page, name);
    if (i % 5 === 0)
      for (let j = 0; j < 3; j++) {
        await page.locator("[data-virtuoso-scroller]").evaluate((el) => { el.scrollTop = 0; });
        await page.waitForTimeout(300);
      }
    if (i === 5) warm = await counters();
  }
  const end = await counters();
  // Before transcripts were dropped and images held as Blobs, each chat added
  // about 16 MB of heap (base64 screenshots, outputs): 10 more chats, 160 MB.
  expect(end.heap - warm.heap).toBeLessThan(20);
  expect(end.heap).toBeLessThan(60);
  expect(end.nodes).toBeLessThan(warm.nodes * 1.5);
  expect(end.listeners).toBeLessThan(warm.listeners * 1.5);
  // A dropped chat reads its transcript again; a recent one is still there.
  await open(page, "Mem 00");
  await expect(page.locator(".item").last()).toContainText(/Round 699|Done/);
  await open(page, "Mem 15");
  // Screenshots show from blob URLs, never base64 data URLs.
  const images = page.locator(".item img");
  for (let i = 0; i < 30 && !(await images.count()); i++) {
    await page.locator("[data-virtuoso-scroller]").evaluate((el) => { el.scrollTop -= 600; });
    await page.waitForTimeout(100);
  }
  await expect(images.first()).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(360);
});

test("This device keeps the chosen chat memory", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "This device" }).click();
  const dialog = page.getByRole("dialog", { name: "This device" });
  await expect(dialog.getByRole("radio", { name: /Recent 20/ })).toBeChecked();
  await dialog.getByRole("radio", { name: /Recent 5/ }).check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("casm.chat-memory"))).toBe("5");
  await page.reload();
  await page.getByRole("button", { name: "This device" }).click();
  await expect(page.getByRole("dialog", { name: "This device" }).getByRole("radio", { name: /Recent 5/ })).toBeChecked();
});

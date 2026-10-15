import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (page.viewportSize()!.width < 600) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".item").last()).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue("");
}

test("bottom working indicator follows selected agent and clears after completion and interruption", async ({ page }) => {
  await login(page);
  const working = page.locator(".chat-working");
  await expect(working).toBeEmpty();
  await send(page, "slow");
  await expect(working).toHaveText("Working");
  await expect(working.locator(".activity-spinner")).toBeVisible();
  const indicatorBox = (await working.boundingBox())!;
  const composerBox = (await page.locator(".composer").boundingBox())!;
  expect(indicatorBox.y + indicatorBox.height).toBeLessThanOrEqual(composerBox.y);
  expect(indicatorBox.y).toBeGreaterThan(450);
  await page.getByLabel("Message").fill("agent zero draft");
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(working).toBeEmpty();
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.getByLabel("Message").fill("agent one draft");
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(working).toHaveText("Working");
  await expect(page.getByLabel("Message")).toHaveValue("agent zero draft");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(working).toBeEmpty();
  await send(page, "slow");
  await expect(working).toHaveText("Working");
  await page.getByLabel("Message").fill("complete this turn");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  // Switching agents preserves reader position; the new reply can be below
  // the virtualized viewport even though its turn has completed.
  const latest = page.getByRole("button", { name: "Latest ↓", exact: true });
  if (await latest.isVisible()) await latest.click();
  await expect(page.getByText("echo: complete this turn", { exact: true })).toBeVisible();
  await expect(working).toBeEmpty();
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(page.getByLabel("Message")).toHaveValue("agent one draft");
  await expect(working).toBeEmpty();
});

for (const width of [1440, 375]) {
  test(`status changes preserve reader position and pinned composer at width ${width}`, async ({ page, isMobile }) => {
    await page.setViewportSize({ width, height: 812 });
    let notify: (status: string, failed?: boolean) => void = () => { throw new Error("Socket not ready"); };
    await page.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer();
      let agentId = "";
      socket.onMessage((message) => {
        const request = JSON.parse(String(message));
        if (request.method === "agent.subscribe") agentId = request.params.id;
        server.send(message);
      });
      notify = (status, failed = false) => {
        if (failed) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: {
          agentId, event: { type: "turnEnded", outcome: "failed" },
        } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.status", params: { agentId, status } }));
      };
    });
    await login(page);
    const scroller = page.locator("[data-virtuoso-scroller]");
    await scroller.hover();
    // A finger drag: touchmove, then the scroll it causes.
    if (isMobile) { await scroller.dispatchEvent("touchmove"); await scroller.evaluate((el) => el.scrollBy(0, -700)); }
    else await page.mouse.wheel(0, -700);
    await expect(page.getByRole("button", { name: "Latest ↓" })).toBeVisible();
    // Let scrolling settle before comparing exact reader coordinates.
    await page.waitForTimeout(250);
    const before = await scroller.evaluate((element) => element.scrollTop);
    const composer = (await page.locator(".composer").boundingBox())!;
    const working = page.locator(".chat-working");
    notify("running");
    await expect(working).toHaveText("Working");
    expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(2);
    expect(await page.locator(".composer").boundingBox()).toEqual(composer);
    expect(composer.y + composer.height).toBeLessThanOrEqual(812);
    // The status line starts at the composer's left edge, above it.
    // Measure the status element, not the spinner: a rotating box's bounds
    // change with the animation phase.
    const status = (await working.boundingBox())!;
    expect(status.x - composer.x).toBeGreaterThanOrEqual(-0.5);
    expect(status.x - composer.x).toBeLessThan(8);
    expect(status.y + status.height).toBeLessThanOrEqual(composer.y + 0.5);
    notify("idle", true);
    await expect(working).toBeEmpty();
    expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(2);
    expect(await page.locator(".composer").boundingBox()).toEqual(composer);
    notify("running");
    await expect(working).toHaveText("Working");
    notify("waiting");
    await expect(working).toBeEmpty();
    notify("idle");
  });
}

for (const width of [1440, 375]) {
  test(`transcript rows, the pill row and the composer share one column at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await login(page);
    const edges = (selector: string) => page.locator(selector).last().evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [Math.round(box.left * 2) / 2, Math.round(box.right * 2) / 2];
    });
    const composer = await edges(".composer");
    expect(await edges(".item")).toEqual(composer);
    expect(await edges(".user .message-content")).toEqual(composer);
    // The pill row floats over the transcript's end and is transparent: no
    // band covers the transcript, only the pills are surfaces.
    const row = page.locator(".pill-row");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(row).toHaveCSS("position", "absolute");
    await page.getByLabel("Message").fill("slow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const pill = page.locator(".working-pill");
    await expect(pill).toHaveText("Working");
    await expect(pill.locator(".activity-spinner")).toBeVisible();
    expect(await edges(".pending-queue")).toEqual(composer);
    const pillBox = (await pill.boundingBox())!;
    expect(Math.abs(pillBox.x - composer[0])).toBeLessThan(1);
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual((await page.locator(".composer").boundingBox())!.y);
    expect(pillBox.height).toBe(width < 600 ? 32 : 28);
    // The pill sits over the transcript's end, which still reaches the bottom area.
    const running = (await page.locator("[data-virtuoso-scroller]").boundingBox())!;
    expect(Math.abs(running.y + running.height - (await page.locator(".pending-queue").boundingBox())!.y)).toBeLessThan(1);
    expect(pillBox.y).toBeGreaterThan(running.y);
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(running.y + running.height + 0.5);
    await expect(pill).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
}

test("the working spinner holds still with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await page.getByLabel("Message").fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".working-pill .activity-spinner")).toHaveCSS("animation-name", "none");
});

for (const width of [1440, 375]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`Latest sits on the column's right edge in the pill row; the end clears the pills at width ${width} ${scheme}`, async ({ page, isMobile }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 812 });
      await login(page);
      // Following: the last line ends above the pill row, nothing is hidden under it.
      await page.getByLabel("Message").fill("slow");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const pill = page.locator(".working-pill");
      await expect(pill).toBeVisible();
      await expect.poll(async () => {
        const last = (await page.locator(".item").last().boundingBox())!;
        return last.y + last.height <= (await pill.boundingBox())!.y + 1;
      }).toBe(true);
      await page.screenshot({ path: info.outputPath(`following-${scheme}.png`) });
      // Scrolled up: Latest ↓ joins the row on the right, the same pill size.
      // Let the end settle first, as a reader's scroll comes after it.
      await page.waitForTimeout(250);
      const scroller = page.locator("[data-virtuoso-scroller]");
      await scroller.hover();
      if (isMobile) { await scroller.dispatchEvent("touchmove"); await scroller.evaluate((el) => el.scrollBy(0, -700)); }
      else await page.mouse.wheel(0, -700);
      const latest = page.getByRole("button", { name: "Latest ↓", exact: true });
      await expect(latest).toBeVisible();
      const composer = (await page.locator(".composer").boundingBox())!;
      const latestPill = (await latest.locator(".latest-pill").boundingBox())!;
      const working = (await pill.boundingBox())!;
      expect(Math.abs(latestPill.x + latestPill.width - (composer.x + composer.width))).toBeLessThan(1);
      expect(Math.abs(working.x - composer.x)).toBeLessThan(1);
      expect(latestPill.height).toBe(working.height);
      expect(Math.abs(latestPill.y - working.y)).toBeLessThan(1);
      await page.screenshot({ path: info.outputPath(`latest-${scheme}.png`) });
      await page.screenshot({ path: `/tmp/cb-shots/latest-${width}-${scheme}.png` });
      await latest.click();
      await expect(latest).toBeHidden();
      await expect.poll(async () => {
        const last = (await page.locator(".item").last().boundingBox())!;
        return last.y + last.height <= (await pill.boundingBox())!.y + 1;
      }).toBe(true);
    });
  }
}

import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (page.viewportSize()!.width < 600) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByText("Message 319", { exact: false })).toBeVisible();
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
  await expect(working).toHaveText("Working…");
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
  await expect(working).toHaveText("Working…");
  await expect(page.getByLabel("Message")).toHaveValue("agent zero draft");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(working).toBeEmpty();
  await send(page, "slow");
  await expect(working).toHaveText("Working…");
  await page.getByLabel("Message").fill("complete this turn");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(page.getByText("echo: complete this turn", { exact: true })).toBeVisible();
  await expect(working).toBeEmpty();
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(page.getByLabel("Message")).toHaveValue("agent one draft");
  await expect(working).toBeEmpty();
});

for (const width of [1440, 375]) {
  test(`status changes preserve reader position and pinned composer at width ${width}`, async ({ page }) => {
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
    await page.mouse.wheel(0, -700);
    await expect(page.getByRole("button", { name: "Latest ↓" })).toBeVisible();
    // Let the native wheel scroll settle before comparing exact reader coordinates.
    await page.waitForTimeout(250);
    const before = await scroller.evaluate((element) => element.scrollTop);
    const composer = (await page.locator(".composer").boundingBox())!;
    const working = page.locator(".chat-working");
    notify("running");
    await expect(working).toHaveText("Working…");
    expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(2);
    expect(await page.locator(".composer").boundingBox()).toEqual(composer);
    expect(composer.y + composer.height).toBeLessThanOrEqual(812);
    const center = await working.evaluate((element) => {
      const spinner = element.querySelector(".activity-spinner")!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNode(element.lastChild!);
      return (spinner.left + text.getBoundingClientRect().right) / 2;
    });
    expect(Math.abs(center - (composer.x + composer.width / 2))).toBeLessThan(2);
    notify("idle", true);
    await expect(working).toBeEmpty();
    expect(Math.abs(await scroller.evaluate((element) => element.scrollTop) - before)).toBeLessThan(2);
    expect(await page.locator(".composer").boundingBox()).toEqual(composer);
    notify("running");
    await expect(working).toHaveText("Working…");
    notify("waiting");
    await expect(working).toBeEmpty();
    notify("idle");
  });
}

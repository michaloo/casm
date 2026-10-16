import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByLabel("Message")).toBeVisible();
}
async function paste(page: Page, data = png) {
  await page.getByLabel("Message").evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, data);
  await expect(page.locator("form img[alt='Attached image 1']")).toBeVisible();
}
test("pasted image draft follows its agent, reloads and sends without text", async ({ page }) => {
  await login(page);
  await paste(page);
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(page.locator("form .image-attachments")).toHaveCount(0);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator("form img")).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator("form img")).toHaveCount(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("form img")).toHaveCount(0);
  await expect(page.locator(".item.user img").last()).toBeVisible();
  // Shown from a Blob holding the same bytes, not a base64 data URL.
  await expect(page.locator(".item.user img").last()).toHaveAttribute("src", /^blob:/);
  expect(await page.locator(".item.user img").last().evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  })).toBe(png);
});
test("failed image send retains draft and removable preview", async ({ page }) => {
  await login(page);
  await paste(page);
  await page.evaluate(() => {
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      const message = JSON.parse(String(data));
      if (message.method === "agent.send") message.params.id = "missing-image-agent";
      return original.call(this, JSON.stringify(message));
    };
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Agent not found|agent not found|not found/, { exact: false }).first()).toBeVisible();
  await expect(page.locator("form img")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove image 1" }).click();
  await expect(page.locator("form img")).toHaveCount(0);
});
test("large images stay in current draft but are silently omitted from storage", async ({ page }) => {
  await login(page);
  await page.getByLabel("Message").fill("keep the text");
  await paste(page, png.replace(/=+$/, "") + "AAAA".repeat(260000));
  await page.waitForTimeout(300);
  await expect(page.locator("form img")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Message")).toHaveValue("keep the text");
  await expect(page.locator("form img")).toHaveCount(0);
});

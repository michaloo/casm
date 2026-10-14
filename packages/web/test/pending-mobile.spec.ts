import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

for (const width of [1440, 375]) test(`ten queued messages collapse, persist per agent, and reveal new failures at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  let fail = false;
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const pending = new Set<number>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.pending") pending.add(request.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      if (pending.delete(response.id)) response.result = { messages: Array.from({ length: 10 }, (_, i) => ({
        id: `queued-${i}`, text: `Queued message ${i} ${"long text ".repeat(20)}`, reason: i === 0 ? fail ? "failed" : "limit" : "busy",
      })) };
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const openAgent = async (name: string) => {
    if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(name) }).click();
  };
  await openAgent("Agent 00");
  const toggle = page.locator(".queue-toggle");
  await expect(toggle).toContainText("10 queued");
  await expect(toggle).toContainText("1 waiting");
  await expect(toggle).toHaveAttribute("title", /1 waiting for limit/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".pending-row").first()).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".pending-row")).toHaveCount(10);
  expect((await page.getByLabel("Message").boundingBox())!.y).toBeLessThan(812);
  await toggle.click();
  await openAgent("Agent 01");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await openAgent("Agent 00");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await openAgent("Agent 01");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  fail = true;
  await openAgent("Agent 02");
  await expect(toggle).toContainText("1 failed");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("1 failed");
});

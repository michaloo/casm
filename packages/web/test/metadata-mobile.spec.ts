import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

for (const width of [1440, 375]) test(`sender provenance and held queue metadata fit at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const methods = new Map<number, string>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      methods.set(request.id, request.method);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      if (methods.get(response.id) === "agent.list" && response.result) {
        for (const agent of response.result.agents) {
          if (agent.name === "Agent 00") agent.pending = { count: 3, held: { reason: "failed", note: "Provider could not resume the session" } };
          if (agent.name === "Agent 01") agent.pending = { count: 2, held: { reason: "limit", note: "Waiting for the provider window to reset" } };
        }
      }
      if (methods.get(response.id) === "agent.history" && response.result) {
        response.result = { start: 0, items: [
          { kind: "user", id: "sender-agent", text: "Agent report", sender: { serverId: "server", agentId: "reporter", name: "Researcher", host: "ubuntu" } },
          { kind: "user", id: "sender-schedule", text: "Scheduled report", sender: { serverId: "server", agentId: "schedule:job", host: "macbook", schedule: { id: "job", name: "Morning check" } } },
        ] };
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  const failed = page.getByRole("button", { name: /Agent 00/ });
  const limited = page.getByRole("button", { name: /Agent 01/ });
  await expect(failed).toContainText("3 queued");
  await expect(failed.locator(".dot")).toHaveAttribute("aria-label", "Queue needs retry");
  await expect(failed.locator(".dot")).toHaveAttribute("title", "Queue needs retry · Provider could not resume the session");
  await expect(failed.locator(".dot")).toHaveClass(/failed/);
  await expect(limited.locator(".dot")).toHaveAttribute("aria-label", "Queue waiting for limit");
  expect(await failed.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await failed.click();
  await expect(page.locator(".message-sender").filter({ hasText: "Researcher · ubuntu" })).toBeVisible();
  await expect(page.locator(".message-sender").filter({ hasText: "Schedule: Morning check · macbook" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

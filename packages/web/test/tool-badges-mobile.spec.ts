import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) test(`mobile tool badges stay on one line with long titles at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  const command = "cd ~/code/refs && git log --all --format=fuller ".repeat(30);
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const histories = new Set<number>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history") histories.add(request.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      if (histories.delete(response.id)) response.result = { start: 0, items: [
        { kind: "subagent", id: "long-subagent", title: command, status: "running", activity: "Inspecting references" },
        { kind: "tool", id: "long-tool", name: "exec_command", input: { command }, status: "error", output: "" },
      ] };
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  for (const selector of [".subagent .row-kind", ".subagent .status", ".tool .status"]) {
    const badge = page.locator(selector);
    await expect(badge).toBeVisible();
    const metrics = await badge.evaluate((el) => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, line: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    expect(metrics.height).toBeLessThanOrEqual(metrics.line + metrics.padding + metrics.border + 1);
  }
  for (const selector of [".subagent summary strong", ".tool-argument"]) {
    const title = page.locator(selector);
    await expect(title).toHaveCSS("text-overflow", "ellipsis");
    expect(await title.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

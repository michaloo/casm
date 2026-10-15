import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`mobile model label resolves Claude session IDs and keeps explicit 1M at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer(), methods = new Map<number, string>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw)); methods.set(request.id, request.method);
      if (request.method === "provider.catalog") {
        socket.send(JSON.stringify({ id: request.id, result: { models: [{ id: "opus", name: "Opus 5.5", isDefault: true }], modes: [] } }));
      } else server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (methods.get(response.id) === "agent.list") {
        const agent = response.result.agents.find((agent: { name: string }) => agent.name === "Agent 00");
        agent.config = {}; agent.effectiveModel = "claude-opus-5-5[1m]";
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  const pill = page.locator(".composer-picker").filter({ has: page.getByRole("combobox", { name: "Model", exact: true }) });
  await expect(pill.locator(".composer-picker-label")).toHaveText("Default · Opus 5.5 · 1M");
  await expect(pill).toHaveAttribute("title", /Reported session model: claude-opus-5-5\[1m\]/);
  await expect(page.locator(".chat-model-label")).toHaveText("Opus 5.5 · 1M");
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("opus");
  await expect(pill.locator(".composer-picker-label")).toHaveText("Opus 5.5");
  await expect(page.locator(".model-session")).toHaveText("Session: Opus 5.5 · 1M");
});

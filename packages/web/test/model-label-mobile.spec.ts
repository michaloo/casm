import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

// Opus 5.5 is natively 1M, so Claude's catalog has no 1M rows.
const models = [{ id: "opus", name: "Opus 5.5", isDefault: true }, { id: "sonnet", name: "Sonnet 5.5" }];

async function openAgent(page: Page, width: number, config: Record<string, string>, effectiveModel: string) {
  await page.setViewportSize({ width, height: 812 });
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer(), methods = new Map<number, string>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw)); methods.set(request.id, request.method);
      if (request.method === "provider.catalog") {
        socket.send(JSON.stringify({ id: request.id, result: { models, modes: [] } }));
      } else server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (methods.get(response.id) === "agent.list") {
        const agent = response.result.agents.find((agent: { name: string }) => agent.name === "Agent 00");
        agent.config = config; agent.effectiveModel = effectiveModel;
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  return page.locator(".composer-picker").filter({ has: page.getByRole("combobox", { name: "Model", exact: true }) });
}

for (const width of [1440, 375]) test(`mobile model label resolves Claude session IDs and keeps explicit 1M at ${width}`, async ({ page }) => {
  const pill = await openAgent(page, width, {}, "claude-opus-5-5[1m]");
  await expect(pill.locator(".composer-picker-label")).toHaveText("Default · Opus 5.5 · 1M");
  await expect(pill).toHaveAttribute("title", /Reported session model: claude-opus-5-5\[1m\]/);
  await expect(page.locator(".chat-model-label")).toHaveText("Opus 5.5 · 1M");
  // The opus alias is the session's model; an unstated context size is no difference.
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("opus");
  await expect(pill.locator(".composer-picker-label")).toHaveText("Opus 5.5");
  await expect(page.locator(".model-session")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("sonnet");
  await expect(page.locator(".model-session")).toHaveText("Session: Opus 5.5 · 1M");
});

test("an agent on the opus alias reporting claude-opus-5-5 shows no session hint", async ({ page }) => {
  const pill = await openAgent(page, 1440, { model: "opus" }, "claude-opus-5-5");
  await expect(pill.locator(".composer-picker-label")).toHaveText("Opus 5.5");
  await expect(page.locator(".chat-model-label")).toHaveText("Opus 5.5");
  await expect(page.locator(".model-session")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("sonnet");
  await expect(page.locator(".model-session")).toHaveText("Session: Opus 5.5");
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("opus");
  await expect(page.locator(".model-session")).toHaveCount(0);
});

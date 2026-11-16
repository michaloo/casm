import { readFileSync } from "node:fs";
import { test, expect, openNewAgent } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";
test.use({ defaultProvider: "codex" });

test("mobile new chats default to Codex after visiting Claude, with an individual device override", async ({ page }) => {
  const creates: any[] = [];
  page.on("websocket", ws => ws.on("framesent", frame => {
    try { const packet = JSON.parse(String(frame.payload)); if (packet.method === "agent.create") creates.push(packet.params); } catch {}
  }));
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".pickers")).toContainText("Claude");
  await openAgents(page);
  await openNewAgent(page);
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("codex");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-6.1-sol");
  await page.getByLabel("Message").fill("New default verified");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("echo: New default verified", { exact: true })).toBeVisible();
  expect(creates.at(-1).provider).toBe("codex");
  expect(creates.at(-1).config.model).toBe("gpt-6.1-sol");
  expect(creates.at(-1).config.mode).toBe("auto-review");
  expect(creates.at(-1).config.effort).toBe("high");
  await openAgents(page);
  await page.getByRole("button", { name: "This device", exact: true }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "Claude", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await openNewAgent(page);
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("claude");
  await page.reload();
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("claude");
});

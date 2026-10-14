import { readFileSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`host settings mobile-safe editing, memories and prompt at ${width}`, async ({ page }) => {
  writeFileSync(`${testHome}/host-settings/AGENTS.md`, "# Shared host instructions\n\nUse isolated fixtures.");
  await page.setViewportSize({ width, height: 812 });
  const hostName = width === 375 ? "Settings peer" : "Test host";
  const routed: (string | undefined)[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (/^(host\.|project.memories|server.(setAgentPrompt|agentPrompt))/.test(request.method)) routed.push(request.host);
      // Mobile exercises the peer UI against this disposable server; the server
      // unit test separately verifies real peer transport for the same methods.
      if (width === 375 && request.method === "peer.list") {
        socket.send(JSON.stringify({ id: request.id, result: { peers: [{ name: hostName, serverId: "settings-peer" }] } }));
        return;
      }
      if (request.host === hostName) delete request.host;
      server.send(JSON.stringify(request));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Toggle Test host host", exact: true }).click();
  const trigger = page.getByRole("button", { name: `${hostName}, online · host menu` });
  await trigger.click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  const panel = page.getByRole("dialog", { name: `${hostName} settings` });
  await expect(panel.getByRole("heading", { name: "Shared host instructions" })).toBeVisible();
  await expect(panel.locator("article.settings-card")).toHaveCount(1);
  await expect(panel.locator("article h4")).toContainText("Claude · Codex · OpenCode · Pi");
  await panel.getByRole("button", { name: "Edit instructions", exact: true }).click();
  await panel.getByRole("textbox", { name: "Global instructions", exact: true }).fill("# My saved instructions\n\nKeep this draft.");
  writeFileSync(`${testHome}/host-settings/AGENTS.md`, "# Concurrent host edit");
  await panel.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Your draft has been kept");
  await panel.getByRole("button", { name: "Review latest version" }).click();
  await expect(panel.getByRole("heading", { name: "Concurrent host edit" })).toBeVisible();
  await panel.getByRole("button", { name: "Keep my draft and use this version for the next save" }).click();
  await panel.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "My saved instructions" })).toBeVisible();
  expect(readFileSync(`${testHome}/host-settings/AGENTS.md`, "utf8")).toContain("Keep this draft");
  await panel.getByRole("button", { name: "Memories", exact: true }).click();
  await panel.locator("summary").filter({ hasText: /^Test project$/ }).click();
  await expect(panel.locator("summary").filter({ hasText: "Project workflow" })).toContainText("How this project is maintained");
  await panel.locator("summary").filter({ hasText: "Project workflow" }).click();
  await expect(panel.getByRole("heading", { name: "Workflow details" })).toBeVisible();
  await panel.getByRole("button", { name: "Agent prompt", exact: true }).click();
  const enabled = panel.getByLabel("Enable host agent prompt");
  await expect(enabled).toBeVisible();
  if (!await enabled.isChecked()) { await enabled.click(); await expect(enabled).toBeChecked(); }
  await panel.getByRole("button", { name: "Edit agent prompt", exact: true }).click();
  await panel.getByRole("textbox", { name: "Agent prompt template", exact: true }).fill("# Custom host prompt\n\nExample agent instructions.");
  await panel.getByRole("button", { name: "Save agent prompt", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Custom host prompt" })).toBeVisible();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(panel.getByText("The host agent prompt is disabled.", { exact: true })).toBeVisible();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect(panel.getByRole("heading", { name: "Custom host prompt" })).toBeVisible();
  await panel.getByRole("button", { name: "Reset to default" }).click();
  await panel.getByRole("button", { name: "Confirm reset" }).click();
  await expect(panel.getByText("Default template", { exact: true })).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(width);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  if (width === 375) {
    expect(bounds!.height).toBe(812);
    for (const button of await panel.locator("button:visible").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(routed.length).toBeGreaterThan(5);
  expect(routed.every((host) => host === (width === 375 ? hostName : undefined))).toBe(true);
  await page.screenshot({ path: `/tmp/host-settings-${width}-${test.info().project.name}.png` });
  await panel.getByRole("button", { name: "Close settings" }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

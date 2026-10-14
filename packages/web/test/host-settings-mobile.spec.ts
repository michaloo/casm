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
  const trigger = page.getByRole("button", { name: `Host options for ${hostName}`, exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  const panel = page.getByRole("dialog", { name: `${hostName} settings` });
  await expect(panel.getByRole("heading", { name: "Shared host instructions" })).toBeVisible();
  await expect(panel.locator("article.settings-card")).toHaveCount(1);
  await expect(panel.locator("article h4")).toContainText("Claude · Codex · OpenCode · Pi");
  await panel.getByRole("button", { name: "Edit instructions", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Global instructions", exact: true });
  await expect(editor).toBeFocused();
  await expect(panel.getByText("No changes")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save instructions", exact: true })).toBeDisabled();
  await editor.fill("# My saved instructions\n\nKeep this draft.");
  await expect(panel.getByText("Unsaved changes")).toBeVisible();
  // Closing with unsaved edits asks first, and keeps the draft.
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("alert")).toContainText("You have unsaved changes.");
  await panel.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("# My saved instructions\n\nKeep this draft.");
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
  // Search loads every project and keeps only the matches.
  await panel.getByRole("searchbox", { name: "Search memories" }).fill("maintained");
  await expect(panel.locator("summary").filter({ hasText: "Project workflow" }).first()).toBeVisible();
  await panel.getByRole("searchbox", { name: "Search memories" }).fill("no such memory");
  await expect(panel.locator("summary").filter({ hasText: "Project workflow" })).toHaveCount(0);
  await panel.getByRole("searchbox", { name: "Search memories" }).fill("");
  const project = panel.locator("details.memory-project").filter({ has: page.locator(".memory-project-name", { hasText: /^Test project$/ }) });
  await project.locator("summary").first().click();
  await expect(project.locator("summary").filter({ hasText: "Project workflow" })).toContainText("How this project is maintained");
  await expect(project.locator("summary .count")).toHaveText("1");
  await project.locator("summary").filter({ hasText: "Project workflow" }).click();
  await expect(project.getByRole("heading", { name: "Workflow details" })).toBeVisible();
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

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`project settings mobile view edit conflict create and memories at ${width}`, async ({ page }) => {
  const file = `${testHome}/AGENTS.md`;
  writeFileSync(file, "# Project rules\n\nUse **careful** tests.");
  await page.setViewportSize({ width, height: 812 });
  const hostName = width === 375 ? "Project peer" : "Test host";
  const routed: { method: string; host?: string; params: Record<string, unknown> }[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (/^project\.(agentsMd|setAgentsMd|memories)$/.test(request.method)) routed.push({ ...request });
      if (width === 375 && request.method === "peer.list") {
        socket.send(JSON.stringify({ id: request.id, result: { peers: [{ name: hostName, serverId: "project-peer" }] } })); return;
      }
      if (request.host === hostName) delete request.host;
      server.send(JSON.stringify(request));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Test host host", exact: true }).click();
  }
  const host = page.locator("section.host").filter({ has: page.getByRole("button", { name: `Host options for ${hostName}`, exact: true }) });
  const trigger = host.getByRole("button", { name: "Project options for Test project", exact: true });
  await trigger.focus(); await trigger.press("Enter");
  const menu = page.getByRole("menu", { name: "Project options for Test project" });
  await expect(menu.getByRole("menuitem", { name: /Settings/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Files/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /New agent here/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(menu.getByRole("menuitem", { name: /Settings/ })).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Test project project settings" });
  await expect(panel.getByRole("heading", { name: "Project rules" })).toBeVisible();
  await panel.getByRole("button", { name: "Edit instructions", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Project instructions", exact: true });
  await editor.fill("# My project draft\n\nKeep my edits.");
  // Switching sections must preserve the unsaved draft.
  await panel.getByRole("button", { name: "Project info", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Project info" })).toContainText(testHome);
  await expect(panel.getByRole("region", { name: "Project info" })).toContainText("No group");
  expect(Number(await panel.locator(".project-info dd").last().textContent())).toBeGreaterThanOrEqual(65);
  await panel.getByRole("button", { name: "AGENTS.md", exact: true }).click();
  await expect(editor).toHaveValue("# My project draft\n\nKeep my edits.");
  writeFileSync(file, "# Concurrent project edit");
  await panel.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Your draft has been kept");
  await panel.getByRole("button", { name: "Review latest version" }).click();
  await expect(panel.getByRole("heading", { name: "Concurrent project edit" })).toBeVisible();
  await panel.getByRole("button", { name: "Keep my draft and use this version for the next save" }).click();
  await panel.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "My project draft" })).toBeVisible();
  expect(readFileSync(file, "utf8")).toContain("Keep my edits.");
  await panel.getByRole("button", { name: "Memories", exact: true }).click();
  const entry = panel.locator("summary").filter({ hasText: "Project workflow" });
  await expect(entry).toContainText("How this project is maintained");
  await entry.click();
  await expect(panel.getByRole("heading", { name: "Workflow details" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Edit/ })).toHaveCount(0);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  if (width === 375) {
    expect((await panel.boundingBox())!.height).toBe(812);
    expect((await panel.boundingBox())!.width).toBe(375);
    for (const button of await panel.locator("button:visible").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `/tmp/casm-project-${width}-${test.info().project.name}.png` });
  await panel.getByRole("button", { name: "Close project settings" }).click();
  await expect(trigger).toBeFocused();
  // Missing files are created with a null SHA precondition.
  rmSync(file);
  await trigger.click();
  await page.getByRole("menuitem", { name: /^Settings/ }).click();
  await panel.getByRole("button", { name: "Create AGENTS.md", exact: true }).click();
  await editor.fill("# Created project instructions");
  await panel.getByRole("button", { name: "Save instructions", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Created project instructions" })).toBeVisible();
  const writes = routed.filter((r) => r.method === "project.setAgentsMd");
  expect(writes[0].params.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(writes.at(-1)!.params.expectedSha256).toBe(null);
  expect(routed.every((r) => r.host === (width === 375 ? hostName : undefined))).toBe(true);
  await panel.getByRole("button", { name: "Project info", exact: true }).click();
  await panel.getByRole("button", { name: "New agent here" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(page.locator("main header strong")).toContainText("Test project");
});

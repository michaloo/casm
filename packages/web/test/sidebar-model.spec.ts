import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("compact provider/model rows and remembered collapse preserve routed agent visibility", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const row = page.getByRole("button", { name: /Agent 00/ });
  await row.click();
  const agentRoute = page.url();
  await expect(row.locator(".provider-icon")).toHaveAttribute("aria-label", "Claude");
  await expect(row.locator(".agent-model")).toContainText("Model unresolved");
  const modelPicker = page.locator(".composer-picker").filter({ has: page.getByRole("combobox", { name: "Model", exact: true }) });
  await expect(modelPicker.locator(".composer-picker-label")).toHaveText("Default");
  await expect(modelPicker).toHaveAttribute("title", /Session model unresolved/);
  await expect(page.getByRole("combobox", { name: "Model", exact: true }).locator("option:checked")).toHaveText("Default — Use the provider's default model");
  const toggle = page.getByRole("button", { name: "Toggle Test project", exact: true });
  await expect(toggle).toBeDisabled();
  await page.getByRole("button", { name: "Test project ＋", exact: true }).click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  const saved = await page.evaluate(() => localStorage.getItem("casm.collapsed-projects"));
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.goto(agentRoute);
  await expect(row).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => localStorage.getItem("casm.collapsed-projects"))).toBe(saved);
});

for (const width of [1440, 375]) test(`host collapse brings peers above the fold and persists at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "peer.list") socket.send(JSON.stringify({ id: request.id, result: { peers: [{ name: "Peer host", serverId: "peer" }] } }));
      else server.send(raw);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const open = async () => {
    if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  };
  await open();
  const toggle = page.getByRole("button", { name: "Toggle Test host host", exact: true });
  await expect(page.getByRole("button", { name: /Agent 00/ })).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("button", { name: /Agent 00/ })).toBeHidden();
  const peer = page.getByRole("button", { name: "Toggle Peer host host", exact: true });
  await expect(peer).toBeInViewport();
  await page.reload();
  await open();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(peer).toBeInViewport();
  await toggle.click();
  await expect(page.getByRole("button", { name: /Agent 00/ })).toBeVisible();
});

import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`mobile slash commands and MCP controls at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  let fallback = false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)); calls.push(request);
      if (fallback && request.method === "agent.mcpStatus") {
        socket.send(JSON.stringify({ id: request.id, result: { servers: [], reconnect: "reload", canToggle: false, message: "No native MCP status API." } })); return;
      }
      if (fallback && request.method === "agent.mcpReconnect") {
        socket.send(JSON.stringify({ id: request.id, result: { mode: "reload", message: "Reloaded the whole agent session to re-read MCP configuration." } })); return;
      }
      server.send(raw);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 03/ }).click();
  const input = page.getByLabel("Message", { exact: true });
  const list = page.getByRole("listbox", { name: "Slash commands" });
  await input.fill("/");
  await expect(list.getByRole("option")).toHaveCount(7);
  await expect(list.getByRole("option").first()).toContainText("/mcp");
  await expect(list.getByRole("option").first()).toContainText("casm action");
  await input.press("ArrowDown");
  await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowUp");
  await input.press("Escape");
  await expect(list).toBeHidden();
  await input.fill("");
  await input.fill("/");
  await expect(list).toBeVisible();
  await input.fill("/rev");
  await expect(list).toContainText("<path>");
  await expect(list).toContainText("To agent");
  await input.press("Tab");
  await expect(input).toHaveValue("/review ");
  await input.fill("/review src");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => calls.some((r) => r.method === "agent.send" && r.params.text === "/review src")).toBe(true);
  await input.fill("/audit");
  await expect(list).toContainText("skill");
  await list.getByRole("option").click();
  await expect(input).toHaveValue("/audit ");
  await input.fill("/mcp");
  await input.press("Enter");
  const panel = page.getByRole("dialog", { name: "MCP servers for Agent 03" });
  await expect(panel).toContainText("needs-auth");
  await panel.getByRole("button", { name: "Reconnect docs", exact: true }).click();
  await expect(panel).toContainText("connected · 3 tools");
  await panel.getByRole("button", { name: "Disable docs", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Reconnect docs", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Enable docs", exact: true }).click();
  await panel.getByRole("button", { name: "Reconnect all", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("reconnected");
  expect(calls.some((r) => r.method === "agent.mcpReconnect" && r.params.server === "docs")).toBe(true);
  expect(calls.some((r) => r.method === "agent.mcpReconnect" && r.params.server === undefined)).toBe(true);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(width);
  if (width === 375) {
    expect(box.height).toBe(812);
    for (const button of await panel.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: `/tmp/casm-mcp-${width}-${test.info().project.name}.png` });
  await panel.getByRole("button", { name: "Close MCP servers" }).click();
  await expect(input).toBeFocused();
  for (const command of ["reload", "restart", "interrupt"]) {
    await input.fill(`/${command}`);
    await list.getByRole("option").filter({ hasText: "casm action" }).click();
    await expect.poll(() => calls.some((r) => r.method === `agent.${command}`)).toBe(true);
    await expect(input).toHaveValue("");
    expect(calls.some((r) => r.method === "agent.send" && r.params.text === `/${command}`)).toBe(false);
  }
  fallback = true;
  await input.fill("/mcp");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel).toContainText("No native MCP status API.");
  await panel.getByRole("button", { name: "Reload agent to reconnect" }).click();
  await expect(panel.getByRole("status")).toContainText("Reloaded the whole agent session");
  await panel.getByRole("button", { name: "Close MCP servers" }).click();
  // A colliding provider command still goes to the agent when explicitly selected.
  await input.fill("/reload");
  await list.getByRole("option").filter({ hasText: "To agent" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => calls.some((r) => r.method === "agent.send" && r.params.text === "/reload ")).toBe(true);
});

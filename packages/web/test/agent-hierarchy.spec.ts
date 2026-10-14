import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("same-server/project nesting preserves selectable rows and excludes unrelated parents", async ({ page }) => {
  await page.routeWebSocket(/.*/, (socket) => {
    const server = socket.connectToServer();
    const methods = new Map<number, string>();
    let serverId = "";
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      methods.set(message.id, message.method);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (methods.get(message.id) === "server.info" && message.result) serverId = message.result.id;
      if (methods.get(message.id) === "agent.list" && message.result) {
        const agents = message.result.agents;
        const find = (name: string) => agents.find((agent: any) => agent.name === name);
        const parent = (child: string, target: string, identity = serverId) => {
          find(child).parent = { serverId: identity, agentId: find(target).id, host: "misleading display hint" };
        };
        parent("Agent 01", "Agent 00");
        parent("Agent 02", "Agent 01");
        parent("Agent 03", "Agent 00", "different-server");
        parent("Agent 04", "Visual review");
        parent("Agent 05", "Agent 06");
        parent("Agent 06", "Agent 05");
        find("Agent 07").parent = { serverId, agentId: "unknown-parent" };
      }
      socket.send(JSON.stringify(message));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  for (let i = 0; i < 8; i++) {
    const name = `Agent ${String(i).padStart(2, "0")}`;
    const row = page.getByRole("button", { name: new RegExp(name) });
    await expect(row).toHaveAttribute("data-depth", String(i === 1 ? 1 : i === 2 ? 2 : 0));
    await expect(row.locator(".provider-icon")).toHaveCount(1);
    await expect(row.locator(".agent-model")).toHaveCount(1);
    await row.click();
    await expect(page.locator("main header strong")).toHaveText(name);
  }
  await expect(page.getByRole("button", { name: /Visual review/ })).toHaveAttribute("data-depth", "0");
  await expect(page.getByText(/\d+ casm agents|from Test host/)).toHaveCount(0);
});

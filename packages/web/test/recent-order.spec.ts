import { test, expect } from "./fixtures.ts";
import { readFileSync } from "node:fs";
import { testHome } from "./config.ts";

test("newest activity is first in the recent preview and the expanded list", async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const listIds = new Set<unknown>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.list") listIds.add(request.id);
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (listIds.delete(response.id)) {
        const chats = response.result?.agents;
        const older = chats?.find((a: { name: string }) => a.name === "Agent 17");
        if (older) older.updatedAt = "2099-01-02T00:00:00Z";
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(testHome + "/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const project = page.locator(".project-group").filter({ has: page.getByRole("button", { name: "Toggle Test project" }) });
  const rows = project.locator(".agent");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("Agent 17");
  await project.getByRole("button", { name: /Show \d+ more chats/ }).click();
  await expect(rows.first()).toContainText("Agent 17");
});


import { test, expect } from "./fixtures.ts";
import { readFileSync } from "node:fs";
import { testHome } from "./config.ts";

test("the last message orders both lists and A-Z stays visible on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.addInitScript(() => localStorage.setItem("casm.chat-sort", "alphabetical"));
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    const listIds = new Set<unknown>();
    const histories = new Map<unknown, string>();
    let lastChat: string;
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.list") listIds.add(request.id);
      if (request.method === "agent.history") histories.set(request.id, request.params.id);
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (listIds.delete(response.id)) {
        const chats = response.result?.agents;
        const older = chats?.find((a: { name: string }) => a.name === "Agent 17");
        if (older) lastChat = older.id;
        const renamed = chats?.find((a: { name: string }) => a.name === "Agent 18");
        if (renamed) renamed.updatedAt = "2099-01-02T00:00:00Z";
      }
      const id = histories.get(response.id);
      if (id) {
        histories.delete(response.id);
        if (id === lastChat) response.result = { start: 0, total: 2, items: [
          { kind: "user", id: "prompt", text: "New message", at: "2070-01-01T00:00:00Z" },
          { kind: "notice", id: "log", text: "Later tool activity", at: "2099-01-01T00:00:00Z" },
        ] };
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
  const order = page.getByRole("group", { name: "Sort conversations" });
  await expect(order.getByRole("button", { name: "A-Z" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first()).not.toContainText("Agent 17");
  await order.getByRole("button", { name: "Latest message" }).click();
  await expect(order.getByRole("button", { name: "A-Z" })).toBeVisible();
  await expect(rows.first()).toContainText("Agent 17");
});

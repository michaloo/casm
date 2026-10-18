import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

test("a failed message retried automatically counts down, with Retry now and Cancel", async ({ page }) => {
  const cancelled: string[] = [];
  const due = Date.now() + 100_000;
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const pending = new Set<number>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.cancelPending" && request.params.messageId === "retrying") {
        cancelled.push(request.params.messageId);
        return socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { cancelled: 1 } }));
      }
      if (request.method === "agent.pending") pending.add(request.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      if (pending.delete(response.id) && !cancelled.length) response.result = { messages: [
        { id: "retrying", agentId: "a", text: "Hourly report", reason: "failed", note: "the server stopped before the agent answered",
          notBefore: new Date(due).toISOString(), retry: { attempt: 2, of: 3 }, createdAt: new Date().toISOString() },
        { id: "behind", agentId: "a", text: "Next one", reason: "queued", createdAt: new Date().toISOString() },
      ] };
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 03/ }).click();
  // A new failure opens the queue by itself.
  await expect(page.locator(".queue-toggle")).toContainText("2 queued · 1 retrying");
  const row = page.locator('.pending-row[data-pending-id="retrying"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Retrying in 1m 3\ds \(attempt 2 of 3\) · the server stopped before the agent answered/);
  await expect(row).toContainText("holds the queue");
  const before = await row.locator("small").textContent();
  await expect(row.locator("small")).not.toHaveText(before!);
  await expect(row.getByRole("button", { name: "Retry now" })).toBeVisible();
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => cancelled).toEqual(["retrying"]);
});

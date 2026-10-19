import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";
import { approvalReview } from "../../server/src/providers/codex-reviews.ts";

for (const width of [1440, 375]) test(`approval review updates with command and rationale at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  const params = { reviewId: "r", targetItemId: "cmd", action: { type: "command", command: "npm test -- --runInBand", cwd: "/repo" } };
  let item = approvalReview({ ...params, review: { status: "inProgress" } })!;
  let update: () => void = () => { throw new Error("not subscribed"); };
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const histories = new Set<number>();
    let agentId = "";
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history") { histories.add(request.id); agentId = request.params.id; }
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (histories.delete(response.id)) response.result = { start: 0, total: 1, items: [item] };
      socket.send(JSON.stringify(response));
    });
    update = () => {
      item = approvalReview({ ...params, review: { status: "approved", rationale: "The user requested these project tests.", riskLevel: "low" } })!;
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId, event: { type: "item", item } } }));
    };
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".tool summary")).toContainText("Approval review");
  await expect(page.locator(".tool-argument")).toHaveText("npm test -- --runInBand");
  update();
  await expect(page.locator(".tool")).toHaveCount(1);
  await expect(page.locator(".tool summary")).toContainText("Review approved");
  await page.locator(".tool summary").click();
  await expect(page.locator(".tool-body")).toContainText("The user requested these project tests.");
  await expect(page.locator(".tool-body")).toContainText("does not mean the action ran or succeeded");
  await expect(page.locator(".tool-body")).toContainText('"targetItemId": "cmd"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.reload();
  await expect(page.locator(".tool summary")).toContainText("Review approved");
  await expect(page.locator(".tool")).toHaveCount(1);
});

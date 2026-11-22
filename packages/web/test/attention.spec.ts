import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) test(`pending child permission is reachable from another chat at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  let childId = "";
  let waiting = false;
  let change: () => void = () => { throw new Error("not connected"); };
  const answers: unknown[] = [];
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const requests = new Map<number, any>();
    change = () => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.status", params: { agentId: childId, status: waiting ? "waiting" : "idle" } }));
    socket.onMessage(raw => {
      const req = JSON.parse(String(raw));
      requests.set(req.id, req);
      if (req.method === "agent.respondPermission") {
        answers.push(req.params);
        waiting = false;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId: childId, event: { type: "permissionResolved", requestId: "test-consent" } } }));
        change();
      } else server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      const req = requests.get(response.id);
      requests.delete(response.id);
      if (req?.method === "agent.list") childId = response.result.agents.find((a: any) => a.name === "Agent 01").id;
      if (req?.method === "agent.subscribe" && req.params.id === childId && waiting)
        response.result.permissions = [{ id: "test-consent", toolName: "test", title: "Test browser consent", input: { testOnly: true }, canAlwaysAllow: false }];
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(page.locator("main header strong")).toHaveText("Agent 01");
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  waiting = true;
  change();
  const banner = page.getByRole("region", { name: "Conversations needing your decision" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: /Open request: Agent 01/ }).click();
  await expect(page.getByText("Test browser consent", { exact: true })).toBeVisible();
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(deny).toBeInViewport();
  await deny.click();
  await expect.poll(() => answers).toEqual([{ id: childId, requestId: "test-consent", decision: "deny" }]);
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

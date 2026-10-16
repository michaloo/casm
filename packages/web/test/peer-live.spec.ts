import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

// A peer's host-level notifications, which the server forwards with the
// peer's name, keep that host's sidebar current without a reload.
test("a peer host's sidebar follows its forwarded changes and reloads when the peer is back", async ({ page }) => {
  const calls: string[] = [];
  let inject: (message: object) => void = () => {};
  let peerAgent: Record<string, any> | undefined;
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const requests = new Map<number, { method: string; host?: string }>();
    inject = message => socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw)); calls.push(request.method); requests.set(request.id, request);
      // A second host, backed by the test server.
      const forwarded = { ...request }; delete forwarded.host; server.send(JSON.stringify(forwarded));
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw)); const request = requests.get(response.id);
      if (request?.method === "peer.list" && response.result) response.result.peers = [{ name: "Remote lab", serverId: "remote-test", url: "ws://unused.test", reachable: true }];
      if (request?.method === "server.info" && request.host && response.result) response.result = { ...response.result, name: "Remote lab", id: "remote-test" };
      if (request?.method === "agent.list" && request.host && response.result) peerAgent = response.result.agents[0];
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("aside")).toContainText("Remote lab");
  await expect.poll(() => !!peerAgent).toBe(true);
  const sidebar = page.locator("aside");
  const agent = { ...peerAgent!, id: "peer-live-agent", name: "Made on the peer", status: "idle", archivedAt: null };
  inject({ method: "agent.changed", params: { agent }, host: "Remote lab" });
  await expect(sidebar.getByText("Made on the peer", { exact: true })).toBeVisible();
  inject({ method: "agent.changed", params: { agent: { ...agent, name: "Renamed on the peer" } }, host: "Remote lab" });
  await expect(sidebar.getByText("Renamed on the peer", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Made on the peer", { exact: true })).toHaveCount(0);
  // Back after a loss: the lists are read again.
  const lists = () => calls.filter(m => m === "peer.list").length;
  const before = lists();
  inject({ method: "peer.status", params: { host: "Remote lab", connected: false }, host: "Remote lab" });
  inject({ method: "peer.status", params: { host: "Remote lab", connected: true }, host: "Remote lab" });
  await expect.poll(lists).toBe(before + 1);
  // The fake agent is gone with the reload, as the peer never had it.
  await expect(sidebar.getByText("Renamed on the peer", { exact: true })).toHaveCount(0);
});

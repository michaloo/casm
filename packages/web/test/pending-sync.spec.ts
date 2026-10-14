import { testHome, testWS } from "./config.ts";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import WebSocket from "ws";
import { test, expect } from "./fixtures.ts";

// A genuine second RPC client; its sends never invoke the browser's send().
async function externalClient() {
  const socket = new WebSocket(testWS, { headers: { Authorization: `Bearer ${readFileSync(`${testHome}/web-token`, "utf8")}` } });
  await once(socket, "open");
  let seq = 0;
  return {
    socket,
    call(method: string, params: Record<string, unknown> = {}): Promise<any> {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out: ${method}`)); }, 5000);
        const receive = (raw: WebSocket.RawData) => {
          const message = JSON.parse(String(raw));
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.off("message", receive);
          message.error ? reject(new Error(message.error.message)) : resolve(message.result);
        };
        socket.on("message", receive);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
  };
}

test("external queue updates survive stale load/live responses and switching cached chats", async ({ page }) => {
  const client = await externalClient();
  const { agents } = await client.call("agent.list");
  const id = agents.find((a: any) => a.name === "Agent 60").id;
  const other = agents.find((a: any) => a.name === "Agent 61").id;
  await client.call("agent.interrupt", { id });
  await client.call("agent.interrupt", { id: other });
  await client.call("agent.send", { id, text: "slow" });
  let holdNext = true;
  let release: (() => void) | undefined;
  let pendingReads = 0;
  await page.routeWebSocket(/.*/, (socket) => {
    const server = socket.connectToServer();
    const requests = new Map<number, any>();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      requests.set(message.id, message);
      if (message.method === "agent.pending" && message.params.id === id) pendingReads++;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const request = requests.get(message.id);
      if (holdNext && request?.method === "agent.pending" && request.params.id === id && message.result) {
        holdNext = false;
        release = () => { socket.send(raw); release = undefined; };
      } else socket.send(raw);
    });
  });
  try {
    await page.goto("/");
    await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: /Agent 60/ }).click();
    await expect.poll(() => !!release).toBe(true);
    // Hold the initial empty load snapshot, then deliver newer live snapshots.
    for (let i = 1; i <= 3; i++) await client.call("agent.send", { id, text: `external queue ${i}` });
    await expect(page.locator(".pending-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: /Agent 60/ })).toContainText("3 queued");
    release!();
    await expect(page.locator(".item").first()).toBeVisible();
    await expect(page.locator(".pending-row")).toHaveCount(3);

    // A stale notification response must also lose to a newer live response.
    holdNext = true;
    await client.call("agent.send", { id, text: "external queue 4" });
    await expect.poll(() => !!release).toBe(true);
    await client.call("agent.send", { id, text: "external queue 5" });
    await expect(page.locator(".pending-row")).toHaveCount(5);
    release!();
    // Let the released response render before checking it cannot restore queue 4.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".pending-row")).toHaveCount(5);
    await page.getByRole("button", { name: /Agent 61/ }).click();
    await expect(page.locator(".item").first()).toBeVisible();
    await expect(page.locator(".pending-row")).toHaveCount(0);
    await client.call("agent.send", { id, text: "external while unselected" });
    await page.getByRole("button", { name: /Agent 60/ }).click();
    await expect(page.locator(".pending-row")).toHaveCount(6);
    await expect(page.locator(".pending-row").last()).toContainText("external while unselected");

    // Cancellation from the second client refreshes the selected queue too.
    const pending = await client.call("agent.pending", { id });
    await client.call("agent.cancelPending", { id, messageId: pending.messages[0].id });
    await expect(page.locator(".pending-row")).toHaveCount(5);
    // No timer-based refresh: after notifications settle, request count is stable.
    const count = pendingReads;
    await page.waitForTimeout(500);
    expect(pendingReads).toBe(count);
  } finally {
    release?.();
    await client.call("agent.interrupt", { id });
    client.socket.close();
  }
});

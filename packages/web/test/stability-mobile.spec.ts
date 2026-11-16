import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome, testWS } from "./config.ts";
import { openAgents } from "./phone.ts";

async function login(page: any) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByText(/Message 319/)).toBeVisible();
}

// A half-open mobile connection is still OPEN in the browser, but carries no
// traffic. Use a proxy instead of Unix-only SIGSTOP so this also runs on Windows.
test("mobile resume restores a silent dead socket and latest reply within four seconds", async ({ page }) => {
  let mute: (() => void) | undefined;
  let latest = false;
  let connections = 0;
  await page.routeWebSocket(/.*/, async ws => {
    connections++;
    const upstream = await ws.connectToServer();
    let silent = false;
    mute = () => { silent = true; };
    ws.onMessage(message => { if (!silent) upstream.send(message); });
    upstream.onMessage(message => {
      if (silent) return;
      const packet = JSON.parse(String(message));
      if (latest && packet.result?.items) packet.result.items.push({ kind: "assistant", id: "new-after-resume", text: "Latest reply recovered" });
      ws.send(JSON.stringify(packet));
    });
  });
  await login(page);
  await page.waitForTimeout(1200);
  mute!(); latest = true;
  const started = Date.now();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Latest reply recovered", { exact: true })).toBeVisible({ timeout: 4000 });
  expect(Date.now() - started).toBeLessThan(4000);
  expect(connections).toBeGreaterThan(1);
  console.log(`silent resume: ${Date.now() - started}ms`);
  await expect(page.locator(".connection-banner")).toHaveCount(0);
});

test("mobile selected chat does not wait for slow peer discovery on reload", async ({ page }) => {
  let slow = false;
  let discoveries = 0;
  await page.routeWebSocket(/.*/, async ws => {
    const upstream = await ws.connectToServer();
    const peerRequests = new Set<number>();
    ws.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (packet.method === "peer.list") peerRequests.add(packet.id);
      upstream.send(message);
    });
    upstream.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (slow && peerRequests.has(packet.id)) {
        discoveries++;
        setTimeout(() => ws.send(message), 6000);
        return;
      }
      if (slow && packet.result?.items) packet.result.items.push({ kind: "assistant", id: "reload-reply", text: "Fresh reply before peers" });
      ws.send(JSON.stringify(packet));
    });
  });
  await login(page);
  slow = true;
  const started = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Fresh reply before peers", { exact: true })).toBeVisible({ timeout: 4000 });
  expect(Date.now() - started).toBeLessThan(4000);
  expect(discoveries).toBeGreaterThan(0);
  console.log(`selected chat with slow peers: ${Date.now() - started}ms`);
});

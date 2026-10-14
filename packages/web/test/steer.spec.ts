import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("composer Steer sends immediately while Queue remains queued", async ({ page }) => {
  const sends: string[] = [];
  const methods: string[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      methods.push(request.method);
      if (request.method === "agent.send") sends.push(request.params.whenBusy);
      server.send(message);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await page.getByLabel("Message").fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Message").fill("default queued");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.locator(".pending-row")).toContainText("default queued");
  await page.getByLabel("Message").fill("steered");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(page.getByText("echo: steered", { exact: true })).toBeVisible();
  await expect(page.locator(".pending-row")).toHaveCount(1);
  expect(sends).toEqual(["queue", "queue", "steer"]);
  expect(methods).not.toContain("agent.interrupt");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

test("a truly deferred Steer explains pending delivery only on its agent", async ({ page }) => {
  let deferred: { id: string; text: string } | undefined;
  const until = new Date(Date.now() + 3600000).toISOString();
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.method === "agent.send" && request.params.whenBusy === "steer") {
        deferred = { id: request.params.id, text: request.params.text };
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
          queued: true, pendingId: "deferred-steer", deferredUntil: until,
        } }));
      } else if (request.method === "agent.pending" && request.params.id === deferred?.id) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { messages: [{
          id: "deferred-steer", agentId: deferred.id, text: deferred.text, reason: "limit", notBefore: until,
          note: "Provider usage limit", createdAt: new Date().toISOString(), attempts: 0,
        }] } }));
      } else server.send(message);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await page.getByLabel("Message").fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByLabel("Message").fill("please steer");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(page.locator(".pending-row")).toContainText("Steer deferred until");
  await expect(page.locator(".pending-row")).toContainText("saved for later");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.getByRole("button", { name: /Agent 01/ }).click();
  await expect(page.getByText(/Steer deferred until/)).toHaveCount(0);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".pending-row")).toContainText("Steer deferred until");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

import { testHome } from "./config.ts";
// The composer and the queue: instant feedback, reconciliation by message id,
// and no duplicates when actions or responses race.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function open(page: Page, agent: string) {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(agent) }).click();
  await expect(page.locator(".item").first()).toBeVisible();
}
async function type(page: Page, text: string, key = "Enter") {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press(key);
}
const rows = (page: Page) => page.locator(".pending-row");
const userItems = (page: Page, text: string) => page.locator(".item.user").filter({ hasText: new RegExp(`^You${text}$`) });

test("a queued message shows at once, Enter queues and Ctrl+Enter steers while busy", async ({ page }) => {
  const sends: any[] = [];
  let release: (() => void) | undefined;
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.send") sends.push(request.params);
      if (request.method === "agent.send" && request.params.text === "held queue")
        release = () => server.send(raw);
      else server.send(raw);
    });
  });
  await open(page, "Agent 50");
  await expect(page.locator(".send-hint")).toHaveText("Enter to send · Shift+Enter for newline");
  await type(page, "slow");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.locator(".send-hint")).toContainText("Enter to queue");
  await expect(page.locator(".send-hint")).toContainText("+Enter to steer");

  // Before the server answers: the composer is empty and the row is there.
  await type(page, "held queue");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Sending…");
  await expect.poll(() => !!release).toBe(true);
  release!();
  await expect(rows(page)).toContainText("Queued");
  await expect(rows(page)).toHaveCount(1);

  await type(page, "steered", "Control+Enter");
  await expect(page.getByText("echo: steered", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  expect(sends.map((s) => s.whenBusy)).toEqual(["queue", "queue", "steer"]);
  expect(sends.every((s) => uuid.test(s.messageId))).toBe(true);
  expect(new Set(sends.map((s) => s.messageId)).size).toBe(3);

  // Cancel hides the row at once; Interrupt is still there.
  await page.locator(".queue-toggle").click();
  await rows(page).getByRole("button", { name: "Cancel" }).click();
  await expect(rows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
});

test("Send now takes the row out at once and delivers it once", async ({ page }) => {
  const methods: string[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      methods.push(JSON.parse(String(raw)).method);
      server.send(raw);
    });
  });
  await open(page, "Agent 51");
  await type(page, "slow");
  await type(page, "next one");
  await expect(rows(page)).toContainText("Queued");
  await page.locator(".queue-toggle").click();
  await rows(page).getByRole("button", { name: "Send now" }).dblclick();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("echo: next one", { exact: true })).toBeVisible();
  await expect(userItems(page, "next one")).toHaveCount(1);
  expect(methods.filter((m) => m === "agent.steerPending")).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a queued message is edited in place and keeps its place", async ({ page }) => {
  await open(page, "Agent 52");
  await type(page, "slow");
  await type(page, "first");
  await type(page, "secnod");
  await expect(rows(page)).toHaveCount(2);
  await page.locator(".queue-toggle").click();
  await rows(page).nth(1).getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Edit queued message").fill("second, fixed");
  await page.getByLabel("Edit queued message").press("Enter");
  await expect(rows(page).nth(1)).toContainText("second, fixed");
  // The server has the new text in the same place.
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("first");
  await expect(rows(page).nth(1)).toContainText("second, fixed");
  // Interrupt keeps the queue, which goes on in order.
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByText("echo: second, fixed", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
});

test("a message the provider never got holds the queue until Retry now", async ({ page }) => {
  await open(page, "Agent 53");
  await type(page, "unavailable at first");
  await expect(rows(page)).toContainText("Not delivered · provider unreachable");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await type(page, "after it");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("holds the queue");
  await expect(page.getByText("echo: after it", { exact: true })).toHaveCount(0);
  await rows(page).nth(0).getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByText("echo: unavailable at first", { exact: true })).toBeVisible();
  await expect(page.getByText("echo: after it", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
});

test("a send whose response is lost goes back to the composer and is not sent twice", async ({ page }) => {
  const ids: string[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const swallow = new Set<number>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.send") {
        ids.push(request.params.messageId);
        if (ids.length === 1) {
          // The server gets it; the browser hears only that the connection broke.
          swallow.add(request.id);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "Connection lost" } }));
        }
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (!swallow.has(message.id)) socket.send(raw);
    });
  });
  await open(page, "Agent 54");
  await type(page, "only once");
  await expect(page.getByRole("alert")).toContainText("Connection lost");
  await expect(page.getByLabel("Message")).toHaveValue("only once");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await expect(page.getByText("echo: only once", { exact: true })).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  await page.reload();
  await expect(page.getByText("echo: only once", { exact: true })).toHaveCount(1);
});

test("after a host's connection drops, every chat cached for it subscribes again", async ({ page }) => {
  const subscribes: string[] = [];
  let inject: (message: object) => void = () => {};
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    inject = (message) => socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.subscribe") subscribes.push(request.params.id);
      server.send(raw);
    });
  });
  await open(page, "Agent 55");
  await page.getByRole("button", { name: /Agent 56/ }).click();
  await expect(page.locator("main header strong")).toHaveText("Agent 56");
  await expect(page.locator(".item").first()).toBeVisible();
  const first = subscribes[0];
  const second = subscribes.at(-1)!;
  expect(second).not.toBe(first);
  const count = (id: string) => subscribes.filter((x) => x === id).length;
  const before = { first: count(first), second: count(second) };
  inject({ method: "peer.disconnected", params: { host: "" } });
  await expect.poll(() => count(second)).toBe(before.second + 1);
  await page.getByRole("button", { name: /Agent 55/ }).click();
  await expect.poll(() => count(first)).toBe(before.first + 1);
});

test("a new agent whose first send fails keeps the draft once, with the agent", async ({ page }) => {
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.send")
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: 1002, message: "Test send failure" } }));
      else server.send(raw);
    });
  });
  await open(page, "Agent 57");
  await page.getByRole("button", { name: "Test project ＋", exact: true }).click();
  await type(page, "draft that moves");
  await expect(page.locator("main header strong")).toHaveText("draft that moves");
  await expect(page.getByRole("alert")).toContainText("Test send failure");
  await expect(page.getByLabel("Message")).toHaveValue("draft that moves");
  await page.getByRole("button", { name: "Test project ＋", exact: true }).click();
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel("Message")).toHaveValue("");
});

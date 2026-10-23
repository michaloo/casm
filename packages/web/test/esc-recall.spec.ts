// Esc right after Enter takes the message back into the composer: out of the
// queue, or by interrupting the turn it started. Nothing else is touched.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

async function open(page: Page, agent: string, width = 1440) {
  await page.setViewportSize({ width, height: 812 });
  const methods: string[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      methods.push(JSON.parse(String(message)).method);
      server.send(message);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: new RegExp(agent) }).click();
  return { input: page.getByLabel("Message", { exact: true }), methods };
}

test("Esc takes back a queued message without interrupting the running turn", async ({ page }) => {
  const { input, methods } = await open(page, "Agent 10");
  await input.fill("slow");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await input.fill("oops, not finished");
  await input.press("Enter");
  await expect(page.locator(".pending-row")).toContainText("oops, not finished");
  await expect(page.locator(".recall-hint")).toContainText("Esc to edit");
  await input.press("Escape");
  await expect(input).toHaveValue("oops, not finished");
  await expect(page.locator(".pending-row")).toHaveCount(0);
  expect(methods).toContain("agent.cancelPending");
  expect(methods).not.toContain("agent.interrupt");
  // The turn it was queued behind still runs.
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

test("Esc interrupts the turn the message just started and puts it back", async ({ page }) => {
  const { input, methods } = await open(page, "Agent 11");
  await input.fill("slow");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await expect(page.locator(".recall-hint")).toContainText("Esc to edit the message you just sent");
  await page.locator(".composer").screenshot({ path: "test-results/esc-recall-hint.png" });
  await input.press("Escape");
  await expect(input).toHaveValue("slow");
  await expect(input).toBeFocused();
  expect(await input.evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(4);
  expect(methods.filter((m) => m === "agent.interrupt")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeHidden();
  // The prompt stays in the transcript, as in the agent's history; a notice says so.
  await expect(page.getByText(/the message is back in the composer/)).toBeVisible();
  await page.locator("main.chat").screenshot({ path: "test-results/esc-recall-interrupted.png" });
  // Esc again does nothing more.
  await input.fill("");
  await input.press("Escape");
  expect(methods.filter((m) => m === "agent.interrupt")).toHaveLength(1);
});

test("Esc leaves a finished turn alone", async ({ page }) => {
  const { input, methods } = await open(page, "Agent 12");
  await input.fill("hello");
  await input.press("Enter");
  await expect(page.getByText("echo: hello", { exact: true })).toBeVisible();
  await expect(page.locator(".recall-hint")).toHaveCount(0);
  await input.press("Escape");
  await expect(page.locator(".recall-hint")).toContainText("Already answered");
  await expect(input).toHaveValue("");
  expect(methods).not.toContain("agent.interrupt");
  expect(methods).not.toContain("agent.cancelPending");
});

test("Esc never clobbers a draft, steals the slash palette's Esc, or takes back a steer", async ({ page }) => {
  const { input, methods } = await open(page, "Agent 13");
  await input.fill("slow");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  // A draft typed since: Esc keeps it, and the turn runs on.
  await input.fill("a new draft");
  await input.press("Escape");
  await expect(input).toHaveValue("a new draft");
  // The slash palette closes on Esc, as before.
  await input.fill("/");
  const list = page.getByRole("listbox", { name: "Slash commands" });
  await expect(list).toBeVisible();
  await input.press("Escape");
  await expect(list).toBeHidden();
  await expect(input).toHaveValue("/");
  expect(methods).not.toContain("agent.interrupt");
  // A steer joins the running turn: nothing to take back.
  await input.fill("steered");
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect(page.getByText("echo: steered", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(input).toHaveValue("");
  expect(methods).not.toContain("agent.interrupt");
  expect(methods).not.toContain("agent.cancelPending");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

test("Esc takes back a queued message at 375 (mobile)", async ({ page }) => {
  const { input, methods } = await open(page, "Agent 14", 375);
  await input.fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  await input.fill("queued on a phone");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByRole("button", { name: /1 queued/ })).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("queued on a phone");
  await expect(page.getByRole("button", { name: /queued/ })).toHaveCount(0);
  expect(methods).toContain("agent.cancelPending");
  expect(methods).not.toContain("agent.interrupt");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

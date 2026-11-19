import { readFileSync } from "node:fs";
import type { Agent, Item } from "@casm/protocol";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

async function login(page: import("@playwright/test").Page, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
}
for (const width of [1440, 375]) {
  test(`mobile recent chats and unread message dots survive reload and offline replies at ${width}`, async ({ page }) => {
    test.setTimeout(60_000); // Several reloads and settings changes; recovery has its own strict 4s test.
    const tails = new Map<string, Item>();
    const ids = new Map<string, string>();
    const statuses = new Map<string, Agent["status"]>();
    const dates = new Map<string, string>();
    let notify: (name: string, status: Agent["status"]) => void;
    let deliver: (name: string, item: Item) => void;
    await page.routeWebSocket("**", socket => {
      const server = socket.connectToServer();
      const requests = new Map<number, { method: string; params: { id?: string; limit?: number } }>();
      socket.onMessage(raw => { const request = JSON.parse(String(raw)); requests.set(request.id, request); server.send(raw); });
      server.onMessage(raw => {
        const response = JSON.parse(String(raw)); const request = requests.get(response.id); requests.delete(response.id);
        if (request?.method === "agent.list" && response.result) {
          response.result.agents = response.result.agents.filter((a: Agent) => /^Agent 0[0-3]$/.test(a.name));
          for (const a of response.result.agents as Agent[]) {
            ids.set(a.name, a.id);
            if (!dates.has(a.id)) dates.set(a.id, new Date(Date.now() - 100_000 + Number(a.name.slice(-2)) * 1000).toISOString());
            a.updatedAt = dates.get(a.id)!;
            a.status = statuses.get(a.id) ?? (a.name === "Agent 01" ? "waiting" : a.name === "Agent 02" ? "failed" : a.name === "Agent 03" ? "running" : "idle");
          }
        }
        if (request?.method === "agent.history" && request.params.id && tails.has(request.params.id) && response.result) {
          if (request.params.limit === 1) response.result.items = [tails.get(request.params.id)];
          else response.result.items.push(tails.get(request.params.id));
        }
        socket.send(JSON.stringify(response));
      });
      notify = (name, status) => { const agentId = ids.get(name)!; statuses.set(agentId, status); socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.status", params: { agentId, status } })); };
      deliver = (name, item) => {
        const agentId = ids.get(name)!; tails.set(agentId, item);
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId, event: { type: "item", item } } }));
      };
    });
    await login(page, width);
    const rows = page.locator("nav .agent");
    await expect(rows.first()).toContainText("Agent 03");
    await page.getByRole("button", { name: "This device", exact: true }).click();
    await page.getByRole("checkbox", { name: /Recent activity first/ }).uncheck();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(rows.first()).toContainText("Agent 00");
    await page.getByRole("button", { name: "This device", exact: true }).click();
    await page.getByRole("checkbox", { name: /Recent activity first/ }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(rows.first()).toContainText("Agent 03");
    await expect(rows.filter({ hasText: "Agent 01" }).locator(".dot")).toHaveClass(/waiting/);
    await expect(rows.filter({ hasText: "Agent 02" }).locator(".dot")).toHaveClass(/failed/);
    await expect(rows.first().locator(".dot")).toHaveClass(/running/);
    await expect(page.locator(".agent-state-line")).toHaveCount(0);
    await expect(page.locator(".unread-label")).toHaveCount(0);
    // Establish a read-message baseline for Agent 00, then leave it in the background.
    await rows.filter({ hasText: "Agent 00" }).click();
    await expect(page.locator(".item").last()).toBeVisible();
    if (width === 375) await openAgents(page);
    await rows.filter({ hasText: "Agent 03" }).click();
    await expect(page.locator(".item").last()).toBeVisible();
    notify!("Agent 00", "running"); notify!("Agent 00", "idle");
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).not.toHaveClass(/unread/);
    tails.set(ids.get("Agent 00")!, { kind: "assistant", id: "background-reply", text: "Background result ready.", at: new Date().toISOString() });
    notify!("Agent 00", "running"); notify!("Agent 00", "idle");
    if (width === 375) await openAgents(page);
    const unread = rows.filter({ hasText: "Agent 00" });
    await expect(unread.locator(".dot")).toHaveClass(/unread/);
    await page.getByRole("button", { name: "This device", exact: true }).click();
    await page.getByRole("checkbox", { name: /Show unread reply indicators/ }).uncheck();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(unread.locator(".dot")).not.toHaveClass(/unread/);
    await page.reload();
    if (width === 375) await openAgents(page);
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).not.toHaveClass(/unread/);
    await page.getByRole("button", { name: "This device", exact: true }).click();
    await page.getByRole("checkbox", { name: /Show unread reply indicators/ }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(unread.locator(".dot")).toHaveClass(/unread/);
    await expect(unread.locator(".agent-name")).toHaveCSS("font-weight", "500");
    expect(await unread.locator(".agent-summary").evaluate(el => el.children.length)).toBe(2);
    notify!("Agent 00", "running");
    await expect(unread.locator(".dot")).toHaveClass(/unread/);
    notify!("Agent 00", "waiting");
    await expect(unread.locator(".dot")).toHaveClass(/waiting/);
    await expect(unread.locator(".dot")).not.toHaveClass(/unread/);
    notify!("Agent 00", "idle");
    await expect(unread.locator(".dot")).toHaveClass(/unread/);
    await expect(rows.first()).toContainText("Agent 00");
    const attention = page.getByRole("button", { name: /Needs attention/ });
    await expect(attention).toHaveText("Needs attention (3)");
    await attention.click();
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Agent 03" })).toHaveCount(0);
    await attention.click();
    await expect(rows).toHaveCount(4);
    await page.waitForTimeout(300);
    await page.reload();
    if (width === 375) await openAgents(page);
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).toHaveClass(/unread/);
    await rows.filter({ hasText: "Agent 00" }).click();
    await expect(page.getByText("Background result ready.", { exact: true })).toBeVisible();
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).not.toHaveClass(/unread/);
    if (width === 375) await openAgents(page);
    await rows.filter({ hasText: "Agent 03" }).click();
    await page.waitForTimeout(300);
    // No event or status change arrives: the next startup must compare the latest item.
    tails.set(ids.get("Agent 00")!, { kind: "assistant", id: "offline-reply", text: "Completed while the app was closed.", at: new Date().toISOString() });
    await page.reload();
    if (width === 375) await openAgents(page);
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).toHaveClass(/unread/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`chat-activity-${width}.png`) });
    await rows.filter({ hasText: "Agent 00" }).click();
    await expect(page.getByText("Completed while the app was closed.", { exact: true })).toBeVisible();
    const scroller = page.locator("[data-virtuoso-scroller]");
    if (test.info().project.use.hasTouch) {
      await scroller.dispatchEvent("touchmove"); await scroller.evaluate(el => el.scrollBy(0, -600));
    } else { await scroller.hover(); await page.mouse.wheel(0, -600); }
    await expect(page.getByRole("button", { name: /Latest/ })).toBeVisible();
    deliver!("Agent 00", { kind: "assistant", id: "new-while-reading-history", text: "A newer message while you read history.", at: new Date().toISOString() });
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).toHaveClass(/unread/);
    await page.getByRole("button", { name: /Latest/ }).click();
    await expect(page.getByText("A newer message while you read history.", { exact: true })).toBeVisible();
    await expect(rows.filter({ hasText: "Agent 00" }).locator(".dot")).not.toHaveClass(/unread/);
  });

  test(`mobile chats can be archived, restored and explicitly removed at ${width}`, async ({ page }) => {
    await login(page, width);
    const row = page.locator("nav .agent").filter({ hasText: "Agent 00" });
    await row.click();
    const archive = async () => {
      await page.getByRole("button", { name: "Chat options", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Chat options", exact: true });
      await dialog.getByRole("button", { name: "Archive chat", exact: true }).click();
      await expect(row).toHaveCount(1);
      await dialog.getByRole("button", { name: "Confirm archive", exact: true }).click();
      await expect(row).toHaveCount(0);
    };
    const archived = async () => {
      if (width === 375) await openAgents(page);
      await page.getByRole("button", { name: "Project options for Test project", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Test project project", exact: true });
      await dialog.getByRole("button", { name: "Archived chats", exact: true }).click();
      return dialog.locator(".archived-chat").filter({ hasText: "Agent 00" });
    };
    await archive();
    let card = await archived();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Restore chat", exact: true }).click();
    await expect(page.locator("main header strong")).toHaveText("Agent 00");
    await expect(row).toHaveCount(1);
    await archive();
    card = await archived();
    await card.getByRole("button", { name: "Delete from CASM...", exact: true }).click();
    const confirm = card.getByRole("button", { name: "Confirm delete", exact: true });
    await expect(confirm).toBeDisabled();
    await card.getByLabel("Chat name to delete").fill("Agent 00");
    await confirm.click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

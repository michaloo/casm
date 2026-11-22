import { readFileSync } from "node:fs";
import type { Item } from "@casm/protocol";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";
import { findInItems } from "../../server/src/find.ts";
import { highlights } from "./find-helpers.ts";

test.use({ workView: "compact" });
const items: Item[] = [
  { kind: "assistant", id: "progress", text: "Checking the next candidates." },
  { kind: "notice", id: "legacy-approved-1", level: "warning", text: "Automatic approval review approved (risk: low, authorization: high): local calculation" },
  { kind: "notice", id: "legacy-approved-2", level: "warning", text: "Automatic approval review approved (risk: low, authorization: high): compare public URLs" },
  { kind: "tool", id: "review:approved", name: "Review approved", status: "done", input: { description: "Read public sources" }, output: "Approved, but not proof the action ran." },
  { kind: "tool", id: "review:denied", name: "Review denied", status: "error", input: { description: "Blocked action" }, output: "Not authorized" },
  { kind: "notice", id: "real-warning", level: "warning", text: "Connection requires your attention." },
  { kind: "notice", id: "legacy-denied", level: "warning", text: "Automatic approval review denied (risk: high): not authorized" },
  { kind: "assistant", id: "finished", text: "The review is finished." },
];
for (const width of [1440, 375]) test(`mobile routine approval notices are grouped, exceptions visible and find opens details at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const requests = new Map<number, { method: string; params: { query?: string; kinds?: Item["kind"][] } }>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history" || request.method === "agent.find") requests.set(request.id, request);
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      const request = requests.get(response.id);
      requests.delete(response.id);
      if (request?.method === "agent.history") response.result = { start: 0, total: items.length, items };
      if (request?.method === "agent.find") response.result = findInItems(items, request.params.query!, { kinds: request.params.kinds });
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).first().click();
  const group = page.locator(".work-details");
  await expect(group).toHaveCount(1);
  await expect(group.locator("summary").first()).toContainText("3 activities");
  await expect(page.getByText(items[1].kind === "notice" ? items[1].text : "", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-item-id="review:denied"] summary')).toContainText("Review denied");
  await expect(page.getByText("Connection requires your attention.", { exact: true })).toBeVisible();
  await expect(page.getByText("Automatic approval review denied (risk: high): not authorized", { exact: true })).toBeVisible();
  await group.locator("summary").first().click();
  await expect(page.locator('[data-item-id="legacy-approved-1"]')).toBeVisible();
  await group.locator("summary").first().click();
  await page.getByRole("button", { name: "Find in chat", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find in chat" }).fill("local calculation");
  await expect(page.locator('[data-item-id="legacy-approved-1"]')).toBeVisible();
  await expect.poll(async () => (await highlights(page)).current).toEqual(["local calculation"]);
  await page.getByRole("button", { name: "Close find" }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: "This device", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "This device" });
  await dialog.getByRole("radio", { name: /Individual/ }).check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".work-details")).toHaveCount(0);
  await expect(page.locator('[data-item-id="legacy-approved-1"]')).toHaveCount(1);
});

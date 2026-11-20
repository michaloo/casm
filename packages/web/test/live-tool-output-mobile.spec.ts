import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { AgentEvent, Item } from "@casm/protocol";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// A command still running shows its newest output lines under its closed
// card, at a fixed height, scrolled to the end; its result replaces them.
const history: Item[] = [{ kind: "user", id: "ask", text: "Run the slow test suite" }];
const tool: Extract<Item, { kind: "tool" }> = {
  kind: "tool",
  id: "live-tool",
  name: "Bash",
  input: { command: "npm test -- --reporter=spec", description: "Run the test suite" },
  status: "running",
};

for (const width of [1440, 375]) test(`a running command streams its output into its card at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 812 });
  let send: (event: AgentEvent) => void = () => { throw new Error("Socket not ready"); };
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const histories = new Set<number>();
    let agentId = "";
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history") histories.add(request.id);
      if (request.method === "agent.subscribe") agentId = request.params.id;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      if (histories.delete(response.id)) response.result = { start: 0, items: history };
      socket.send(JSON.stringify(response));
    });
    send = (event) => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId, event } }));
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.locator(".item.user")).toContainText("Run the slow test suite");

  const card = page.locator(".item.tool").filter({ hasText: "npm test" });
  const live = card.locator(".tool-live pre");
  send({ type: "item", item: tool });
  await expect(card.locator(".status")).toHaveText("Running");
  send({ type: "toolOutput", itemId: tool.id, text: "> casm@1.0.0 test" });
  // Quick commands just finish: nothing shows in their first second.
  await expect(live).toHaveCount(0);
  await expect(live).toBeVisible({ timeout: 3000 });
  await expect(live).toHaveText("> casm@1.0.0 test");
  const height = (await live.boundingBox())!.height;
  const below = async () => (await card.boundingBox())!.height;
  const cardHeight = await below();

  for (let i = 1; i <= 24; i++) send({ type: "toolOutput", itemId: tool.id, text: `\n  ✓ suite ${i} passed (${i * 13} ms)` });
  await expect(live).toContainText("suite 24 passed");
  // Arriving lines neither grow the card nor leave the newest out of view.
  expect((await live.boundingBox())!.height).toBe(height);
  expect(await below()).toBe(cardHeight);
  await expect.poll(() => live.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
  await live.screenshot({ path: info.outputPath(`live-tail-${width}.png`) });
  await card.screenshot({ path: info.outputPath(`live-card-${width}.png`) });

  // Scrolled up, it stays put while more arrives.
  await live.evaluate((el) => new Promise((done) => {
    el.addEventListener("scroll", done, { once: true });
    el.scrollTop = 0;
  }));
  send({ type: "toolOutput", itemId: tool.id, text: "\n  ✓ suite 25 passed" });
  await expect(live).toContainText("suite 25 passed");
  expect(await live.evaluate((el) => el.scrollTop)).toBe(0);

  // Opened, the body holds the output instead, following its end.
  await card.locator("summary").click();
  await expect(live).toHaveCount(0);
  const out = card.locator(".tool-body pre").nth(1);
  await expect(out).toContainText("suite 25 passed");
  send({ type: "toolOutput", itemId: tool.id, text: "\n  ✓ suite 26 passed" });
  await expect(out).toContainText("suite 26 passed");
  await expect.poll(() => out.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
  await card.screenshot({ path: info.outputPath(`live-open-${width}.png`) });
  await card.locator("summary").click();
  await expect(live).toBeVisible();

  // The result replaces the stream; a late chunk doesn't add to it.
  send({ type: "item", item: { ...tool, status: "done", output: "26 suites passed" } });
  send({ type: "toolOutput", itemId: tool.id, text: "\nlate" });
  await expect(card.locator(".status")).toHaveText("Done");
  await expect(live).toHaveCount(0);
  await card.locator("summary").click();
  await expect(card.locator(".tool-body pre").nth(1)).toHaveText("26 suites passed");

  const overflow = await page.locator(".item.tool").evaluateAll((els) => els.some((el) => el.scrollWidth > el.clientWidth + 1));
  expect(overflow).toBe(false);
});

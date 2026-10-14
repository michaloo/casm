import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

for (const fromAgent of [false, true]) for (const source of ["live", "history"]) {
  test(`${fromAgent ? "interagent report" : "human message"} ${source} preserves payload newlines in rendered text only`, async ({ page }) => {
    const text = 'First line\nSecond **bold** line\nLiteral \\n stays literal\n\n- List item\n  continued line\n\n```text\ncode first\ncode second\n```';
    let outgoing = "";
    let incoming = "";
    await page.routeWebSocket("**", (socket) => {
      const server = socket.connectToServer();
      const histories = new Set<number>();
      socket.onMessage((message) => {
        const request = JSON.parse(String(message));
        if (request.method === "agent.history") histories.add(request.id);
        if (request.method === "agent.send") {
          outgoing = request.params.text;
          if (fromAgent) request.params.sender = { serverId: "source-host", agentId: "source-agent", name: "Reporter" };
        }
        server.send(JSON.stringify(request));
      });
      server.onMessage((message) => {
        const response = JSON.parse(String(message));
        const event = response.params?.event;
        if (event?.type === "item" && event.item.kind === "user") incoming = event.item.text;
        if (source === "history" && histories.delete(response.id) && response.result) {
          response.result.items = [
            { kind: "user", id: "history-report", text, ...(fromAgent ? { sender: { serverId: "source-host", agentId: "source-agent", name: "Reporter" } } : {}) },
            { kind: "assistant", id: "history-answer", text: `echo: ${text}` },
          ];
          response.result.start = 0;
          incoming = response.result.items[0].text;
        }
        socket.send(JSON.stringify(response));
      });
    });
    await page.goto("/");
    await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: /Agent 00/ }).click();
    if (source === "live") {
      await page.getByLabel("Message").fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    await expect.poll(() => incoming).toBe(text);
    if (source === "live") expect(outgoing).toBe(text);
    const user = page.locator(".item.user").filter({ hasText: "First line" }).last();
    await expect(user.locator(".message-role")).toHaveText(fromAgent ? "Reporter" : "You");
    await expect(user.locator(".prose > p br")).toHaveCount(2);
    await expect(user.locator("li br")).toHaveCount(1);
    await expect(user.locator("strong")).toHaveText("bold");
    await expect(user.locator(".prose > p")).toContainText('Literal \\n stays literal');
    const lines = await user.locator(".prose > p").evaluate((paragraph) => {
      const positions: number[] = [];
      for (const node of paragraph.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNode(node);
        positions.push(range.getBoundingClientRect().top);
      }
      return positions;
    });
    expect(lines[1]).toBeGreaterThan(lines[0]);
    await expect(user.locator("pre code")).toHaveText("code first\ncode second");
    await expect(user.locator("pre br")).toHaveCount(0);
    const assistant = page.locator(".item.assistant").filter({ hasText: "echo: First line" }).last();
    await expect(assistant.locator(".prose > p br")).toHaveCount(0);
    await expect(assistant.locator("li br")).toHaveCount(0);
    await expect(assistant.locator("strong")).toHaveText("bold");
    await expect(assistant.locator("pre code")).toHaveText("code first\ncode second");
  });
}

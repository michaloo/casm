import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) test(`async questions ${width}: options, free text, reload, independent dismissal and resolution`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  const requests = [
    { id: "async-one", nonBlocking: true, title: "Question while working", prompts: [{ id: "one", text: "Which environment?", kind: "select", allowOther: true, options: [{ label: "Staging (Recommended)" }, { label: "Production" }] }] },
    { id: "async-two", nonBlocking: true, title: "Question while working", prompts: [{ id: "two", text: "Any constraints?", kind: "text" }] },
  ];
  const resolved = new Set<string>();
  const submissions: Record<string, unknown>[] = [];
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const subscriptions = new Set<string | number>();
    socket.onMessage(message => {
      const request = JSON.parse(String(message));
      if (request.method === "agent.subscribe") subscriptions.add(request.id);
      if (request.method === "agent.answerQuestion") {
        submissions.push(request.params);
        resolved.add(request.params.requestId);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId: request.params.id, event: { type: "questionResolved", requestId: request.params.requestId } } }));
      } else server.send(message);
    });
    server.onMessage(message => {
      const response = JSON.parse(String(message));
      if (subscriptions.delete(response.id) && response.result) {
        response.result.questions = requests.filter(q => !resolved.has(q.id));
        response.result.status = "running";
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByText("The agent is still working. Answer before this turn ends.")).toHaveCount(2);
  const first = page.locator(".card").filter({ hasText: "Which environment?" });
  const answer = page.getByLabel("Answer: Which environment?");
  await expect(answer).toHaveValue("");
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  expect(submissions).toHaveLength(0);
  await first.getByRole("button", { name: "Staging (Recommended)", exact: true }).click();
  await expect(answer).toHaveValue("Staging (Recommended)");
  await answer.fill("A separate sandbox");
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(first).toHaveCount(0);
  expect(submissions[0]).toMatchObject({ requestId: "async-one", answers: { one: "A separate sandbox" } });
  await page.reload();
  await expect(page.getByText("Any constraints?", { exact: true })).toBeVisible();
  await expect(page.getByText("Which environment?", { exact: true })).toHaveCount(0);
  const second = page.locator(".card").filter({ hasText: "Any constraints?" });
  await second.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(second).toHaveCount(0);
  expect(submissions[1]).not.toHaveProperty("answers");
  await page.reload();
  await expect(page.locator(".card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

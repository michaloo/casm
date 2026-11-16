import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Item } from "@casm/protocol";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// Commands left running in the background (Claude's Bash run_in_background)
// are tool rows of their own kind, not subagents; a row with nothing to show
// has no fold.
const bash = (id: string, description: string, command: string, rest: Partial<Extract<Item, { kind: "tool" }>>): Item =>
  ({ kind: "tool", id, name: "Bash", input: { command, description, run_in_background: true }, status: "running", background: { taskId: `task-${id}` }, ...rest });
const history: Item[] = [
  { kind: "user", id: "ask", text: "Run the checks in the background" },
  bash("build", "Wait for the build to finish", "npm run build && npm test", { status: "done", output: Array.from({ length: 60 }, (_, i) => `step ${i + 1} of 60`).join("\n") + "\n\n[exited with code 0]" }),
  bash("fixtures", "Fetch test fixtures", "./fetch-fixtures.sh", { status: "error", output: "error: fixture server refused connection\n\n[exited with code 3]" }),
  bash("server", "Keep a scratch server alive", "sleep 300", { status: "error", background: { taskId: "task-server", stopped: true } }),
  bash("watch", "Watch the logs", "tail -f server.log", {}),
  { kind: "subagent", id: "quiet-subagent", title: "Review the diff", status: "running" },
  { kind: "subagent", id: "told-subagent", title: "Audit dependencies", status: "done", summary: "No vulnerable packages." },
];

for (const width of [1440, 375]) test(`background commands show their state and output tail at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  let push: (item: Item) => void = () => { throw new Error("Socket not ready"); };
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
    push = (item) => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { agentId, event: { type: "item", item } } }));
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();

  const row = (title: string) => page.locator(".background-command").filter({ hasText: title });
  await expect(page.locator(".background-command")).toHaveCount(4);
  await expect(page.locator(".subagent").filter({ hasText: "Wait for the build" })).toHaveCount(0);
  await expect(row("Wait for the build to finish").locator(".status")).toHaveText("Done");
  await expect(row("Fetch test fixtures").locator(".status")).toHaveText("Failed");
  await expect(row("Keep a scratch server alive").locator(".status")).toHaveText("Stopped");
  await expect(row("Watch the logs").locator(".status")).toHaveText("Running");
  await expect(row("Wait for the build to finish").locator(".tool-argument")).toHaveText("npm run build && npm test");

  // Nothing to show: one line, no disclosure to open onto nothing.
  for (const title of ["Keep a scratch server alive", "Watch the logs"]) {
    await expect(row(title).locator("details")).toHaveCount(0);
    await expect(row(title).locator(".tool-line")).toBeVisible();
  }
  await expect(page.locator(".subagent").filter({ hasText: "Review the diff" }).locator("details")).toHaveCount(0);
  await expect(page.locator(".subagent").filter({ hasText: "Audit dependencies" }).locator("details")).toHaveCount(1);

  // The tail opens at its newest lines.
  const build = row("Wait for the build to finish");
  await build.locator("summary").click();
  const pre = build.locator(".tool-body pre");
  await expect(pre).toContainText("[exited with code 0]");
  await expect.poll(() => pre.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
  // Titles of rows with and without a fold line up.
  const x = async (title: string) => (await row(title).locator("strong").boundingBox())!.x;
  expect(Math.abs((await x("Watch the logs")) - (await x("Fetch test fixtures")))).toBeLessThan(1);

  // Live: output arrives, then the command ends.
  const watch = history[4] as Extract<Item, { kind: "tool" }>;
  push({ ...watch, output: "GET /health 200" });
  await expect(row("Watch the logs").locator("details")).toHaveCount(1);
  push({ ...watch, output: "GET /health 200\n\n[exited with code 0]", status: "done" });
  await expect(row("Watch the logs").locator(".status")).toHaveText("Done");
  await row("Watch the logs").locator("summary").click();
  await expect(row("Watch the logs").locator(".tool-body")).toContainText("GET /health 200");

  // Nothing overflows the phone width.
  const overflow = await page.locator(".background-command").evaluateAll((els) => els.some((el) => el.scrollWidth > el.clientWidth + 1));
  expect(overflow).toBe(false);
});

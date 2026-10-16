import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// Agent ids as the server reports them, so the seeded calls can use id prefixes.
function collectAgents(value: unknown, into: Map<string, string>) {
  if (Array.isArray(value)) for (const v of value) collectAgents(v, into);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.name === "string" && typeof o.projectId === "string") into.set(o.name, o.id);
    for (const v of Object.values(o)) collectAgents(v, into);
  }
}

const message = [
  "Main agent: the **launcher** is merged. Please rebase `casm-tool-rows` on main and:",
  "",
  "- keep the casm styling",
  "- run the Playwright specs on Chromium and WebKit",
  "- send me the commit hash",
  "",
  "After that, take before/after screenshots at 1440 and 375 and attach their paths. ".repeat(3),
].join("\n");

const items = (ids: Map<string, string>) => [
  { kind: "user", id: "casm-ask", text: "Coordinate the workers" },
  { kind: "tool", id: "casm-send", name: "Bash", status: "done", input: { command: `casm send ${ids.get("Agent 01")!.slice(0, 8)} "${message.replace(/`/g, "\\`")}"`, description: "Message worker" }, output: "" },
  { kind: "tool", id: "casm-steer", name: "shell", status: "done", input: { command: `/bin/bash -lc "casm send --steer 'Visual review' 'Stop and rebase first.'"` }, output: "queued behind the running turn" },
  { kind: "tool", id: "casm-run", name: "Bash", status: "done", input: { command: `cd ~/Explorations && casm run --project "Test project" --name "Agent 02" "Build the sidebar"` }, output: `${ids.get("Agent 02")}\n` },
  { kind: "tool", id: "casm-wait", name: "exec_command", status: "done", input: { command: `casm send 'Visual review' "Status?" && casm wait 'Visual review'` }, output: "All three specs are green.\n\nCommit `abc1234` is on main." },
  { kind: "tool", id: "casm-peer", name: "Bash", status: "running", input: { command: "casm -H buildbox agents" }, output: "" },
  { kind: "tool", id: "casm-unknown", name: "Bash", status: "error", input: { command: "casm frobnicate --hard thing" }, output: "unknown command: frobnicate" },
  { kind: "tool", id: "plain-shell", name: "Bash", status: "done", input: { command: "ls -la" }, output: "total 0" },
];

for (const width of [1440, 375]) test(`casm CLI calls read as casm rows at ${width} (mobile)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const ids = new Map<string, string>();
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const histories = new Set<number>();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history") histories.add(request.id);
      server.send(raw);
    });
    server.onMessage((raw) => {
      const response = JSON.parse(String(raw));
      collectAgents(response, ids);
      if (histories.delete(response.id) && ids.has("Agent 01")) response.result = { start: 0, items: items(ids) };
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();

  const rows = page.locator(".casm-tool");
  await expect(rows).toHaveCount(6);
  // The plain shell command keeps the generic row.
  await expect(page.locator(".tool:not(.casm-tool) summary")).toContainText("ls -la");
  await expect(page.getByText('"command"')).toHaveCount(0);

  const send = rows.filter({ hasText: "Main agent" });
  await expect(send.locator(".casm-verb")).toHaveText("Send");
  const target = send.getByRole("link", { name: "Agent 01" });
  await expect(target).toHaveAttribute("href", new RegExp(`/a/${ids.get("Agent 01")}$`));
  await expect(send.locator(".casm-result")).toHaveText("sent");
  const steer = rows.nth(1);
  await expect(steer.locator(".casm-verb")).toHaveText("Steer");
  await expect(steer.getByRole("link", { name: "Visual review" })).toBeVisible();
  await expect(steer.locator(".casm-result")).toHaveText("queued behind the running turn");
  await expect(steer.locator(".prose")).toHaveText("Stop and rebase first.");

  const run = rows.nth(2);
  await expect(run.locator(".casm-verb")).toHaveText("Run");
  await expect(run.getByRole("link", { name: "Agent 02" })).toHaveAttribute("href", new RegExp(`/a/${ids.get("Agent 02")}$`));
  await expect(run.locator(".prose")).toHaveText("Build the sidebar");

  const wait = rows.nth(3);
  await expect(wait.locator(".casm-verb")).toHaveText("Send · Wait");
  await expect(wait.locator(".casm-head").getByRole("link", { name: "Visual review" })).toBeVisible();
  await expect(wait.locator(".casm-text-label").filter({ hasText: "Reply" })).toBeVisible();
  await expect(wait.locator(".prose code")).toHaveText("abc1234");

  const peer = rows.nth(4);
  await expect(peer.locator(".casm-verb")).toHaveText("Agents");
  await expect(peer.locator(".casm-peer")).toHaveText("@buildbox");
  await expect(peer.locator(".status.running")).toBeVisible();

  const unknown = rows.nth(5);
  await expect(unknown.locator(".casm-verb")).toHaveText("casm frobnicate");
  await expect(unknown.locator(".casm-result")).toHaveText("unknown command: frobnicate");

  // One page-side read: a virtual row can unmount between separate calls.
  const rights = await page.locator(".casm-head").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
  expect(rights.length).toBeGreaterThan(0);
  for (const right of rights) expect(right).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  if (process.env.CASM_SHOTS) await page.screenshot({ path: `${process.env.CASM_SHOTS}/casm-rows-${width}.png` });

  // Expanding grows the first row; a tall window keeps every row in the virtual range.
  await page.setViewportSize({ width, height: 2400 });
  // The message is prose, collapsed until asked for.
  await expect(send.locator(".prose strong")).toHaveText("launcher");
  await expect(send.locator(".prose li")).toHaveCount(3);
  const clamp = send.locator(".casm-prose");
  expect(await clamp.evaluate((el) => el.scrollHeight > el.clientHeight + 4)).toBe(true);
  await send.getByRole("button", { name: "Show more" }).click();
  expect(await clamp.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // Raw command and output stay one click away.
  await send.getByRole("button", { name: "Show raw command and output" }).click();
  await expect(send.locator(".casm-raw .code-block").first()).toContainText(`casm send ${ids.get("Agent 01")!.slice(0, 8)}`);
  await expect(send.locator(".casm-raw")).toContainText("No output");

  // The agent name opens its chat.
  await target.click();
  await expect(page).toHaveURL(new RegExp(`/a/${ids.get("Agent 01")}$`));
});

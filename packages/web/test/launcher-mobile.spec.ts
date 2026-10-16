import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) test(`global launcher mobile shortcuts search navigation and project actions at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 812 });
  const calls: string[] = [];
  let offline = false;
  let disconnect = () => {};
  await page.routeWebSocket("**", socket => {
    if (offline) { socket.close(); return; }
    disconnect = () => { offline = true; socket.close(); };
    const server = socket.connectToServer();
    const requests = new Map<number, { method: string; host?: string }>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw)); calls.push(request.method); requests.set(request.id, request);
      // A deterministic second host, backed by the disposable provider only.
      const forwarded = { ...request }; delete forwarded.host; server.send(JSON.stringify(forwarded));
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw)); const request = requests.get(response.id);
      if (request?.method === "peer.list" && response.result) response.result.peers = [{ name: "Remote lab", serverId: "remote-test", url: "ws://unused.test", reachable: true }];
      if (request?.method === "server.info" && request.host && response.result) response.result = { ...response.result, name: "Remote lab", id: "remote-test" };
      if (request?.method === "agent.list" && response.result) {
        const agents = response.result.agents;
        for (const agent of agents) {
          if (agent.name === "Agent 01") agent.status = "waiting";
          if (agent.name === "Agent 02") agent.status = "running";
          if (agent.name === "Agent 03") { agent.pending = { count: 3, held: { reason: "failed", note: "Retry needed" } }; agent.subagents = { running: 2, total: 2 }; }
        }
        if (!request.host) for (let i = 0; i < 600; i++) agents.push({ ...agents[0], id: `large-${i}`, name: `Needle ${String(i).padStart(3, "0")}`, status: "idle" });
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("aside")).toContainText("Remote lab");
  if (width === 375) await openAgents(page);
  await page.locator("aside .agent").filter({ hasText: "Agent 00" }).first().click();
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  const initial = page.url();
  const dialog = page.getByRole("dialog", { name: "Global launcher" });
  const input = dialog.getByRole("combobox");
  for (const shortcut of ["Control+k", "Meta+k"]) {
    await page.keyboard.press(shortcut);
    await expect(dialog).toBeVisible(); await expect(input).toBeFocused();
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  }
  // Preserve the browser's Open File shortcut for both platform modifiers.
  for (const modifier of ["ctrlKey", "metaKey"]) {
    expect(await page.evaluate(modifier => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", [modifier]: true, cancelable: true })), modifier)).toBe(true);
    await expect(dialog).toHaveCount(0);
  }
  expect(await page.evaluate(() => !window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })))).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toContainText(/Agent 01|Agent 03/);
  expect(await dialog.getByRole("option").count()).toBeLessThan(30);
  // The empty state is a short start page: host actions appear once, for the current host.
  // Compact single-line rows: 38px with a mouse, 44px on touch.
  const row = (await dialog.getByRole("option").first().boundingBox())!;
  expect(Math.round(row.height)).toBe(info.project.use.hasTouch || width === 375 ? 44 : 38);
  // A pointer resting over the list must not take the selection when keys scroll it.
  const third = (await dialog.getByRole("option").nth(2).boundingBox())!;
  await page.mouse.move(third.x + 40, third.y + third.height / 2, { steps: 3 });
  await expect(dialog.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true");
  // Actions start with Find in chat, for the open chat.
  await input.press("Shift+Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Find in chat");
  await page.waitForTimeout(150);
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Find in chat");
  const options = await dialog.getByRole("option").allTextContents();
  expect(options.filter(text => text.startsWith("Find in chat"))).toHaveLength(1);
  expect(options.filter(text => text.startsWith("New project"))).toEqual(["New projectTest host"]);
  // Schedules are the open chat's project's.
  expect(options.filter(text => text.startsWith("Schedules"))).toEqual(["SchedulesTest projectTest host"]);
  expect(options.some(text => /^(Project options|Host usage|Host resources|Host AGENTS\.md|System Prompt)/.test(text))).toBe(false);
  await input.press("Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText(/Agent 01|Agent 03/);
  await page.waitForTimeout(150);
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Close launcher" })).toBeVisible({ visible: width === 375 });
  await page.waitForTimeout(250);
  const before = calls.length;
  await input.fill("ndle599");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText("Needle 599");
  await expect(dialog.locator("mark").first()).toBeVisible();
  expect(calls.length).toBe(before);
  await input.fill("does not exist zzz");
  await expect(dialog.getByText("No matches for", { exact: false })).toBeVisible();
  await input.fill("");
  await input.press("Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Test project");
  await input.press("Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText(/Find in chat|New project|Schedules/);
  await input.fill("Agent 02 Test host");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Agent 02");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("main header strong")).toHaveText("Agent 02");
  expect(page.url()).not.toBe(initial);
  await page.goBack(); await expect(page.locator("main header strong")).toHaveText("Agent 00");
  // Desktop has one launcher button, in the sidebar; narrow screens get a copy in the chat header
  const headerTrigger = page.locator(".chat > header").getByRole("button", { name: "Open launcher" });
  if (page.viewportSize()!.width <= 650) await headerTrigger.click();
  else { await expect(headerTrigger).toBeHidden(); await page.locator("aside > header").getByRole("button", { name: "Open launcher" }).click(); }
  await input.fill("Agent 0 Test host");
  const first = await input.getAttribute("aria-activedescendant");
  await input.press("ArrowDown"); expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);
  await input.press("Control+p"); expect(await input.getAttribute("aria-activedescendant")).toBe(first);
  await input.press("Control+n"); await input.press("ArrowUp"); expect(await input.getAttribute("aria-activedescendant")).toBe(first);
  await input.fill("Agent 02 Test host"); await input.press("Control+Enter");
  await expect(page).toHaveURL(/\/p\/[^/]+\/new/);
  await expect(page.locator("main header strong")).toHaveText("Test project");
  await page.keyboard.press("Control+k");
  await input.fill("Project options Test project Test host");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Project options");
  await input.press("Enter");
  const project = page.getByRole("dialog", { name: "Test project project", exact: true });
  await expect(project).toBeVisible();
  await expect(project.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
  await project.getByRole("button", { name: "Close project options" }).click();
  // Ctrl/Cmd+Enter on a project opens its options as well.
  await page.keyboard.press("Control+k"); await input.fill("Test project");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Test project");
  await input.press("Control+Enter"); await expect(project).toBeVisible();
  await project.getByRole("button", { name: "Close project options" }).click();
  await page.keyboard.press("Control+k"); await input.fill("Host AGENTS.md Remote lab"); await input.press("Enter");
  const host = page.getByRole("dialog", { name: "Remote lab host" });
  await expect(host).toBeVisible(); await expect(host.getByRole("button", { name: "AGENTS.md", exact: true })).toHaveAttribute("aria-pressed", "true");
  await host.getByRole("button", { name: "Close host options" }).click();
  // From the new-agent draft, Schedules opens that project's Schedules tab.
  await page.keyboard.press("Control+k"); await input.fill("Schedules");
  await expect.poll(async () => (await dialog.getByRole("option").filter({ hasText: /^Schedules/ }).allTextContents()).sort())
    .toEqual(["Schedules: Design reviewDesign reviewRemote lab", "Schedules: Test projectTest projectRemote lab", "SchedulesTest projectTest host"]);
  await input.fill("Schedules Test host"); await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  const schedules = page.getByRole("dialog", { name: "Test project project", exact: true });
  await expect(schedules).toBeVisible();
  await expect(schedules.getByRole("button", { name: "Schedules", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(schedules.getByRole("region", { name: "Schedules" })).toContainText("No schedules in this project yet");
  await schedules.getByRole("button", { name: "Close project options" }).click();
  // Another host has no current project: one entry per project.
  await page.keyboard.press("Control+k"); await input.fill("Schedules: Design review Remote lab"); await input.press("Enter");
  const remote = page.getByRole("dialog", { name: "Design review project", exact: true });
  await expect(remote).toBeVisible();
  await expect(remote.getByRole("button", { name: "Schedules", exact: true })).toHaveAttribute("aria-pressed", "true");
  await remote.getByRole("button", { name: "Close project options" }).click();
  await page.keyboard.press("Control+k"); await input.fill("New project Remote lab"); await input.press("Enter");
  const newProject = page.getByRole("dialog", { name: "New project on Remote lab" });
  await expect(newProject).toBeVisible();
  await newProject.getByRole("button", { name: "Close new project" }).click();
  await page.keyboard.press("Control+k"); await input.fill("Agent 04 Remote lab");
  await expect(dialog.getByRole("option")).toHaveCount(1); await input.press("Enter");
  await expect(page).toHaveURL(/\/h\/Remote%20lab\/a\//);
  await expect(page.locator("main header strong")).toHaveText("Agent 04");
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("casm.launcher.recent") ?? "{}")).length)).toBeGreaterThan(2);
  await page.reload(); await expect(page.locator("main header strong")).toHaveText("Agent 04");
  if (width === 375) await openAgents(page);
  await page.locator("aside > header").getByRole("button", { name: "Open launcher" }).click();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  if (width === 375) { expect(Math.round(bounds.width)).toBe(375); expect(Math.round(bounds.height)).toBe(812); }
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await dialog.screenshot({ path: info.outputPath(`launcher-${width}-${colorScheme}.png`) });
  }
  if (width === 1440) { await page.mouse.click(2, 2); await expect(dialog).toHaveCount(0); }
  else { await dialog.getByRole("button", { name: "Close launcher" }).click(); await expect(dialog).toHaveCount(0); }
  disconnect();
  await expect(page.locator(".chat > header .error")).toHaveText("Offline");
  await page.keyboard.press("Control+k");
  const offlineCalls = calls.length;
  await input.fill("Agent 04 Remote lab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Agent 04");
  await expect(dialog.getByRole("option", { selected: true }).getByRole("img", { name: "Offline", exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(page.locator("main header strong")).toHaveText("Agent 04");
  expect(calls.length).toBe(offlineCalls);
});

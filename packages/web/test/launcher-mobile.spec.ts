import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

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
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
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
  await page.waitForTimeout(250);
  const before = calls.length;
  await input.fill("ndle599");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("option")).toContainText("Needle 599");
  await expect(dialog.locator("mark").first()).toBeVisible();
  expect(calls.length).toBe(before);
  await input.fill("does not exist zzz");
  await expect(dialog.getByText("No matches.", { exact: false })).toBeVisible();
  await input.fill("");
  await input.press("Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText(/New agent in|Open project options/);
  await input.press("Tab");
  await expect(dialog.getByRole("option", { selected: true })).toContainText(/Host options|New project on/);
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
  await input.fill("Open project options Test project Test host"); await input.press("Enter");
  const project = page.getByRole("dialog", { name: "Test project project", exact: true });
  await expect(project).toBeVisible(); await project.getByRole("button", { name: "Info", exact: true }).click();
  await expect(project.getByRole("button", { name: "New agent", exact: true })).toBeVisible();
  await project.getByRole("button", { name: "Close project options" }).click();
  await page.keyboard.press("Control+k"); await input.fill("Host options Instructions Remote lab"); await input.press("Enter");
  const host = page.getByRole("dialog", { name: "Remote lab host" });
  await expect(host).toBeVisible(); await expect(host.getByRole("button", { name: "Instructions", exact: true })).toHaveAttribute("aria-pressed", "true");
  await host.getByRole("button", { name: "Close host options" }).click();
  await page.evaluate(() => window.addEventListener("casm:open-schedules", event => { (window as any).__scheduleHost = (event as CustomEvent).detail.host; }));
  await page.keyboard.press("Control+k"); await input.fill("Schedules on Remote lab"); await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__scheduleHost)).toBe("Remote lab");
  const schedules = page.getByRole("dialog", { name: "Remote lab host" });
  await expect(schedules).toBeVisible();
  await expect(schedules.getByRole("button", { name: "Schedules", exact: true })).toHaveAttribute("aria-pressed", "true");
  await schedules.getByRole("button", { name: "Close host options" }).click();
  await page.keyboard.press("Control+k"); await input.fill("New project on Remote lab"); await input.press("Enter");
  const newProject = page.getByRole("dialog", { name: "New project on Remote lab" });
  await expect(newProject).toBeVisible();
  await newProject.getByRole("button", { name: "Close new project" }).click();
  await page.keyboard.press("Control+k"); await input.fill("Agent 04 Remote lab");
  await expect(dialog.getByRole("option")).toHaveCount(1); await input.press("Enter");
  await expect(page).toHaveURL(/\/h\/Remote%20lab\/a\//);
  await expect(page.locator("main header strong")).toHaveText("Agent 04");
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("casm.launcher.recent") ?? "{}")).length)).toBeGreaterThan(2);
  await page.reload(); await expect(page.locator("main header strong")).toHaveText("Agent 04");
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator("aside > header").getByRole("button", { name: "Open launcher" }).click();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  if (width === 375) { expect(bounds.width).toBe(375); expect(bounds.height).toBe(812); }
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

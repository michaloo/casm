import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

for (const width of [1440, 375]) for (const colorScheme of ["light", "dark"] as const)
  test(`sidebar mobile status and aligned metadata at ${width} ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ colorScheme });
    await page.routeWebSocket("**", socket => {
      const server = socket.connectToServer();
      const methods = new Map<number, string>();
      let serverId = "";
      socket.onMessage(raw => {
        const request = JSON.parse(String(raw)); methods.set(request.id, request.method); server.send(raw);
      });
      server.onMessage(raw => {
        const response = JSON.parse(String(raw));
        if (methods.get(response.id) === "server.info") serverId = response.result.id;
        if (methods.get(response.id) === "agent.list") {
          const agents = response.result.agents;
          for (let i = 0; i < 12; i++) {
            const agent = agents.find((a: { name: string }) => a.name === `Agent ${String(i).padStart(2, "0")}`);
            agent.name += " · Research a very long task with multiple providers and queues";
            agent.config.model = "a-very-long-model-name-with-context-and-provider-details";
            agent.status = i === 0 || i === 5 ? "running" : i === 1 ? "waiting" : "idle";
            if (i !== 3) {
              agent.pending = { count: i + 1, ...(i === 2 ? { held: { reason: "failed", note: "Provider failed to resume this queued work" } } : {}) };
              agent.subagents = { running: 2, total: 2 };
            }
            if (i === 4) agent.deferred = { until: "2099-01-01T00:00:00Z", reason: "Provider limit" };
            if (i === 1 || i === 2) agent.parent = { serverId, agentId: agents.find((a: { name: string }) => a.name.startsWith(`Agent 0${i - 1}`)).id };
          }
        }
        socket.send(JSON.stringify(response));
      });
    });
    await page.goto("/");
    await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    if (width === 375) await openAgents(page);
    const row = (index: number) => page.locator("nav .agent").filter({ hasText: `Agent 0${index}` });
    await row(0).click();
    const header = page.locator(".chat > header");
    await expect(header.locator(".dot")).toHaveAttribute("aria-label", "Working");
    await expect(header.locator(".activity-spinner")).toHaveCount(0);
    expect(await header.innerText()).not.toContain("Working");
    if (width === 375) await openAgents(page);
    // Status dots line up under the project's ⋯, the sidebar's right-hand column.
    const menuBox = (await page.getByRole("button", { name: "Project options for Test project", exact: true }).boundingBox())!;
    let height = 0;
    for (let i = 0; i < 8; i++) {
      const agent = row(i);
      await expect(agent.locator(".dot")).toHaveCount(1);
      await expect(agent.locator(".activity-spinner")).toHaveCount(0);
      expect(await agent.innerText()).not.toMatch(/Working|Idle|Needs you/);
      const dot = (await agent.locator(".dot").boundingBox())!;
      expect(Math.abs(dot.x + dot.width / 2 - menuBox.x - menuBox.width / 2)).toBeLessThanOrEqual(1.5);
      const box = (await agent.boundingBox())!;
      if (height) expect(box.height).toBe(height);
      height = box.height;
      const meta = agent.locator(".agent-meta");
      await expect(meta).toHaveCSS("white-space", "nowrap");
      expect((await meta.boundingBox())!.height).toBeLessThan(22);
      expect(await agent.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await expect(row(0).locator(".agent-meta")).toHaveAttribute("title", /2 sub · 1 queued/);
    await expect(row(2).locator(".dot")).toHaveAttribute("title", /Provider failed to resume/);
    await expect(row(2).locator(".dot")).toHaveClass(/failed/);
    await expect(row(1).locator(".dot")).toHaveClass(/waiting/);
    await expect(row(3).locator(".dot")).toHaveClass(/idle/);
    await expect(row(4).locator(".dot")).toHaveClass(/limited/);
    for (let i = 0; i < 3; i++) await expect(row(i)).toHaveAttribute("data-depth", String(i));
    const icons = await Promise.all([0, 1, 2].map(i => row(i).locator(".provider-icon").boundingBox()));
    expect(icons[1]!.x - icons[0]!.x).toBe(14);
    expect(icons[2]!.x - icons[1]!.x).toBe(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`sidebar-${width}-${colorScheme}.png`) });
  });

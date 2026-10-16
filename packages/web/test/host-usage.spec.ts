import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

test("host usage is the host modal's first tab, with refresh and graceful missing-provider data", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Host options for Test host", exact: true });
  const panel = page.getByRole("dialog", { name: "Test host host" });
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("region", { name: "Usage" })).toBeVisible();
  // Host load moved to its own Resources tab: Usage is provider limits only.
  await expect(panel.getByRole("region", { name: "Host load" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  await expect(panel).toContainText(/No provider usage reported|Usage unavailable|No usage windows reported/);
  await panel.getByRole("button", { name: "Refresh usage" }).click();
  await expect(panel.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByLabel("Message")).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`usage tab spacing/type/bounds ${viewport.width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.routeWebSocket("**", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const request = JSON.parse(String(message));
          if (request.method !== "provider.limits") { server.send(message); return; }
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { limits: [
            { provider: "claude", plan: "Max", updatedAt: new Date().toISOString(), windows: [
              { id: "five-hour", label: "5-hour", usedPercent: 100, status: "exhausted", windowMinutes: 300, resetsAt: new Date(Date.now() + 2.5 * 3600000).toISOString() },
              { id: "week", label: "Weekly", usedPercent: 42, status: "ok", windowMinutes: 10080, resetsAt: new Date(Date.now() + 2 * 86400000).toISOString() },
            ] },
            { provider: "codex", plan: "Pro", updatedAt: new Date().toISOString(), windows: [
              { id: "primary", label: "5-hour", usedPercent: 23, status: "ok", resetsAt: new Date(Date.now() + 45 * 60000).toISOString() },
            ] },
          ] } }));
        });
      });
      await page.goto("/");
      await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      if (viewport.width < 600) await openAgents(page);
      await page.getByRole("button", { name: /Agent 00/ }).click();
      if (viewport.width < 600) await openAgents(page);
      const trigger = page.getByRole("button", { name: /^Host options for / }).first();
      const row = page.getByRole("button", { name: /Agent 00/ });
      const before = await row.boundingBox();
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /host$/ });
      const panel = dialog.getByRole("region", { name: "Usage" });
      await expect(panel).toContainText("100% used · exhausted");
      // A marker shows how far into each window we are (Codex's window here has no length).
      const marks = panel.locator(".usage-now");
      await expect(marks).toHaveCount(2);
      const at = await marks.evaluateAll((els) => els.map((el) => parseFloat((el as HTMLElement).style.left)));
      expect(at[0]).toBeCloseTo(50, 0);
      expect(at[1]).toBeCloseTo(71.4, 0);
      await panel.screenshot({ path: test.info().outputPath(`usage-${viewport.width}-${colorScheme}.png`) });
      expect(await panel.locator(".provider-icon").first().evaluate((element) => getComputedStyle(element).maskImage)).not.toBe("none");
      await expect(panel.locator("time").first()).toHaveAttribute("title", /.+/);
      await expect(panel.locator("time").first()).toContainText("in 2h");
      const typography = await panel.evaluate((element) => {
        const css = getComputedStyle(element);
        return { transform: css.textTransform, tracking: css.letterSpacing, size: parseFloat(css.fontSize) };
      });
      expect(typography.transform).toBe("none");
      expect(["normal", "0px"]).toContain(typography.tracking);
      expect(typography.size).toBeGreaterThanOrEqual(12);
      const box = (await dialog.boundingBox())!;
      if (viewport.width < 600) expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, viewport.width, viewport.height]);
      else {
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
      }
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const values = panel.locator(".usage-window-values").first();
      const label = (await values.locator("span").nth(0).boundingBox())!;
      const amount = (await values.locator("span").nth(1).boundingBox())!;
      expect(amount.x - label.x - label.width).toBeGreaterThanOrEqual(6);
      const reset = (await panel.locator(".usage-window small").first().boundingBox())!;
      expect(reset.y).toBeGreaterThanOrEqual(label.y + label.height);
      expect((await row.boundingBox())!.y).toBe(before!.y);
      await page.screenshot({ path: `/tmp/casm-host-usage-${viewport.width}-${colorScheme}.png` });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`resources tab shows CPU, load, RAM and swap with tones ${viewport.width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      let calls = 0;
      const GB = 2 ** 30;
      await page.routeWebSocket("**", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const request = JSON.parse(String(message));
          if (request.method !== "host.stats") { server.send(message); return; }
          calls++;
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            cpuPercent: 87.4, cores: 4, loadAverage: [6.5, 3.2, 1.1],
            memory: { total: 16 * GB, available: 0.5 * GB, used: 15.5 * GB }, swap: { total: 2 * GB, used: 0.5 * GB },
            uptimeSeconds: 90000, processRss: 200 * 2 ** 20, runningAgents: 2, sampledAt: new Date().toISOString(),
          } }));
        });
      });
      await page.goto("/");
      await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      if (viewport.width < 600) await openAgents(page);
      await page.getByRole("button", { name: /Agent 00/ }).click();
      if (viewport.width < 600) await openAgents(page);
      const trigger = page.getByRole("button", { name: /^Host options for / }).first();
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: /host$/ });
      await expect(dialog.getByRole("region", { name: "Host load" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Resources", exact: true }).click();
      const card = dialog.getByRole("region", { name: "Resources" }).getByRole("region", { name: "Host load" });
      await expect(card).toContainText("87%");
      await expect(card).toContainText("4 cores");
      await expect(card).toContainText("2 running");
      await expect(card).toContainText("6.50 · 3.20 · 1.10");
      await expect(card).toContainText("15.5 GB of 16.0 GB");
      await expect(card).toContainText("0.5 GB of 2.0 GB");
      // Full width: the card spans the panel's content box.
      const panelBox = await dialog.getByRole("region", { name: "Resources" }).evaluate((el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); });
      expect(Math.abs((await card.boundingBox())!.width - panelBox)).toBeLessThan(2);
      const tone = (name: string) => card.getByLabel(name, { exact: true }).locator(".usage-meter").getAttribute("class");
      expect(await tone("CPU")).toContain("high");
      expect(await tone("Load")).toContain("high"); // load1 6.5 > 4 cores
      expect(await tone("RAM")).toContain("full"); // 97%
      expect(await tone("Swap")).not.toMatch(/high|full/);
      // Inside the dialog's bounds.
      const box = (await card.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await card.screenshot({ path: test.info().outputPath(`host-card-${viewport.width}-${colorScheme}.png`) });
      // Leaving the tab stops its reads (the 10 s cadence is covered in host-meter.spec.ts).
      await dialog.getByRole("button", { name: "Usage", exact: true }).click();
      await expect(card).toHaveCount(0);
      expect(calls).toBeGreaterThan(0);
    });
  }
}

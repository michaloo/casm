import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("host usage is an optional disclosure with refresh and graceful missing-provider data", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const toggle = page.getByLabel(/Provider usage on/).first();
  const panel = page.getByRole("dialog", { name: /provider usage/ }).first();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  await expect(panel).toContainText(/No provider usage reported|Usage unavailable|No usage windows reported/);
  await panel.getByRole("button", { name: "Refresh usage" }).click();
  await expect(panel.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
  await toggle.click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByLabel("Message")).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`usage popover spacing/type/bounds ${viewport.width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.routeWebSocket("**", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const request = JSON.parse(String(message));
          if (request.method !== "provider.limits") { server.send(message); return; }
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { limits: [
            { provider: "claude", plan: "Max", updatedAt: new Date().toISOString(), windows: [
              { id: "five-hour", label: "5-hour", usedPercent: 100, status: "exhausted", resetsAt: new Date(Date.now() + 2.5 * 3600000).toISOString() },
              { id: "week", label: "Weekly", usedPercent: 42, status: "ok", resetsAt: new Date(Date.now() + 2 * 86400000).toISOString() },
            ] },
            { provider: "codex", plan: "Pro", updatedAt: new Date().toISOString(), windows: [
              { id: "primary", label: "5-hour", usedPercent: 23, status: "ok", resetsAt: new Date(Date.now() + 45 * 60000).toISOString() },
            ] },
          ] } }));
        });
      });
      await page.goto("/");
      await page.getByLabel("Server token").fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      if (viewport.width < 600) await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: /Agent 00/ }).click();
      if (viewport.width < 600) await page.getByRole("button", { name: "Agents", exact: true }).click();
      const trigger = page.getByLabel(/Provider usage on/).first();
      const row = page.getByRole("button", { name: /Agent 00/ });
      const before = await row.boundingBox();
      await trigger.click();
      const panel = page.getByRole("dialog", { name: /provider usage/ });
      await expect(panel).toContainText("100% used · exhausted");
      expect(await panel.locator(".provider-icon").first().evaluate((element) => getComputedStyle(element).maskImage)).not.toBe("none");
      await expect(panel.locator("time").first()).toHaveAttribute("title", /.+/);
      await expect(panel.locator("time").first()).toContainText("in 2h");
      expect(await panel.evaluate((element) => element.parentElement === document.body && element.matches(":popover-open"))).toBe(true);
      const typography = await panel.evaluate((element) => {
        const css = getComputedStyle(element);
        return { transform: css.textTransform, tracking: css.letterSpacing, size: parseFloat(css.fontSize) };
      });
      expect(typography.transform).toBe("none");
      expect(["normal", "0px"]).toContain(typography.tracking);
      expect(typography.size).toBeGreaterThanOrEqual(12);
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.y).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);
      expect(box.width).toBeLessThanOrEqual(380);
      const values = panel.locator(".usage-window-values").first();
      const label = (await values.locator("span").nth(0).boundingBox())!;
      const amount = (await values.locator("span").nth(1).boundingBox())!;
      expect(amount.x - label.x - label.width).toBeGreaterThanOrEqual(6);
      const reset = (await panel.locator(".usage-window small").first().boundingBox())!;
      expect(reset.y).toBeGreaterThanOrEqual(label.y + label.height);
      expect((await row.boundingBox())!.y).toBe(before!.y);
      await page.screenshot({ path: `/tmp/casm-host-usage-${viewport.width}-${colorScheme}.png` });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await trigger.click();
      await expect(panel).toBeVisible();
      await page.mouse.click(viewport.width - 4, viewport.height - 4);
      await expect(panel).toBeHidden();
    });
  }
}

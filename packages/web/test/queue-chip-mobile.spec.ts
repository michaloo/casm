import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) for (const colorScheme of ["light", "dark"] as const)
  test(`queue chip mobile cohesion at ${width} ${colorScheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ colorScheme });
    let count = 0;
    let notify: (status: string) => void = () => {};
    await page.routeWebSocket("**", socket => {
      const server = socket.connectToServer();
      const pending = new Set<number>();
      let agentId = "";
      socket.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (request.method === "agent.pending") pending.add(request.id);
        if (request.method === "agent.subscribe") agentId = request.params.id;
        server.send(raw);
      });
      server.onMessage(raw => {
        const response = JSON.parse(String(raw));
        if (pending.delete(response.id)) response.result = { messages: Array.from({ length: count }, (_, index) => ({
          id: `queue-chip-${index}`, text: `Queued message ${index + 1}: review the mobile presentation and queue`, reason: index === 0 ? "limit" : "busy",
        })) };
        socket.send(JSON.stringify(response));
      });
      notify = status => socket.send(JSON.stringify({ method: "agent.status", params: { agentId, status } }));
    });
    await page.goto("/");
    await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const composer = page.locator(".composer");
    const line = page.locator(".composer-status");
    const chip = page.locator(".queue-toggle");
    const queue = page.locator(".pending-queue");
    const working = page.locator(".chat-working");
    for (const [index, queued] of [0, 2, 10].entries()) {
      count = queued;
      if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`Agent 0${index}`) }).click();
      if (count) {
        await expect(chip).toContainText(`${count} queued`);
        await expect(chip).toContainText("· 1 waiting for limit");
        await expect(chip).toHaveAttribute("aria-expanded", "false");
      } else await expect(chip).toHaveCount(0);
      for (const status of ["idle", "running"]) {
        notify(status);
        if (status === "running") await expect(working).toHaveText("Working…");
        else await expect(working).toBeEmpty();
        const box = (await composer.boundingBox())!;
        const queueBox = (await queue.boundingBox())!;
        expect(Math.abs(queueBox.x - box.x)).toBeLessThan(1);
        expect(Math.abs(queueBox.width - box.width)).toBeLessThan(1);
        expect(box.y + box.height).toBeLessThanOrEqual(812);
        await expect(queue).toHaveCSS("border-top-width", "0px");
        await expect(queue).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        if (count) {
          const chipBox = (await chip.boundingBox())!;
          expect(chipBox.width).toBeLessThan(box.width);
          expect(chipBox.height).toBe(44);
          const label = (await chip.locator(".queue-count").boundingBox())!;
          const chevron = (await chip.locator(".queue-chevron").boundingBox())!;
          expect(chevron.x - label.x - label.width).toBeLessThan(6);
          expect(chevron.width).toBe(16);
          if (status === "running") {
            const indicator = (await working.boundingBox())!;
            expect(Math.abs(indicator.y + indicator.height / 2 - chipBox.y - chipBox.height / 2)).toBeLessThan(1);
          }
        }
        expect(await line.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.screenshot({ path: info.outputPath(`queue-${count}-${status}-${colorScheme}.png`) });
      }
      if (count) {
        await chip.click();
        await expect(page.locator(".pending-row")).toHaveCount(count);
        const list = page.locator(".queue-list");
        await expect(list).toBeVisible();
        const listBox = (await list.boundingBox())!;
        expect(listBox.y + listBox.height).toBeLessThanOrEqual((await line.boundingBox())!.y);
        expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(812);
        if (count === 10) await page.screenshot({ path: info.outputPath(`queue-expanded-${colorScheme}.png`) });
        await chip.click();
        await expect(list).toBeHidden();
      }
    }
  });

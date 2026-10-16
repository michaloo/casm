import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
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
          id: `queue-chip-${index}`, reason: index === 0 ? "limit" : "queued",
          text: index === 1 ? "A longer queued message: check the deploy, compare the screenshots at 375 and 1440 in light and dark, then write up what changed and what still needs a decision before we ship it." : `Queued message ${index + 1}: review the mobile presentation and queue`,
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
    const pill = chip.locator(".queue-pill");
    const queue = page.locator(".pending-queue");
    const working = page.locator(".chat-working");
    const list = page.locator(".queue-list");
    const phone = width === 375;
    for (const [index, queued] of [0, 2, 6].entries()) {
      count = queued;
      if (phone) await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`Agent 0${index}`) }).click();
      if (count) {
        await expect(chip).toContainText(`${count} queued`);
        await expect(chip).toContainText("· 1 waiting");
        await expect(chip).toHaveAttribute("aria-expanded", "false");
      } else await expect(chip).toHaveCount(0);
      for (const status of ["idle", "running"]) {
        notify(status);
        if (status === "running") await expect(working).toHaveText("Working");
        else await expect(working).toBeEmpty();
        const box = (await composer.boundingBox())!;
        const queueBox = (await queue.boundingBox())!;
        expect(Math.abs(queueBox.x - box.x)).toBeLessThan(1);
        expect(Math.abs(queueBox.width - box.width)).toBeLessThan(1);
        expect(box.y + box.height).toBeLessThanOrEqual(812);
        // The status line floats over the transcript's end, transparent.
        await expect(page.locator(".pill-row")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        if (count) {
          // A small pill like the composer pickers, still 44px to tap on phones.
          const chipBox = (await pill.boundingBox())!;
          expect(chipBox.width).toBeLessThan(box.width);
          expect(chipBox.height).toBe(phone ? 32 : 28);
          await expect(pill).toHaveCSS("border-top-left-radius", phone ? "16px" : "14px");
          expect((await chip.boundingBox())!.height).toBe(phone ? 44 : 28);
          if (status === "running") {
            const indicator = (await working.boundingBox())!;
            expect(Math.abs(indicator.y + indicator.height / 2 - chipBox.y - chipBox.height / 2)).toBeLessThan(1.5);
          }
        }
        expect(await line.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.screenshot({ path: info.outputPath(`queue-${count}-${status}-${colorScheme}.png`) });
      }
      if (count) {
        await chip.click();
        // A mouse or touch click leaves no focus ring; the keyboard still gets one.
        await expect(chip).toHaveCSS("outline-style", "none");
        await expect(pill).toHaveCSS("outline-style", "none");
        await expect(page.locator(".pending-row")).toHaveCount(count);
        await expect(list).toBeVisible();
        const listBox = (await list.boundingBox())!;
        // The pills stay over the transcript's end; the list opens below them.
        expect((await pill.boundingBox())!.y + (await pill.boundingBox())!.height).toBeLessThanOrEqual(listBox.y);
        // The composer sits below the list and never covers it.
        expect(listBox.y + listBox.height).toBeLessThanOrEqual((await composer.boundingBox())!.y + 0.5);
        // Its visible bottom edge is on top, not hidden under the composer.
        expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".queue-list"), [listBox.x + 8, listBox.y + listBox.height - 3])).toBe(true);
        expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(812);
        // Rows: text and actions never overlap, nothing is clipped sideways.
        for (const row of await page.locator(".pending-row").all()) {
          const text = (await row.locator(".pending-text").boundingBox())!;
          const actions = (await row.locator(".pending-actions").boundingBox())!;
          if (!phone) expect(text.x + text.width).toBeLessThanOrEqual(actions.x);
          else expect(text.y + text.height).toBeLessThanOrEqual(actions.y + 1);
          expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          for (const button of await row.locator(".pending-actions button").all())
            expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(phone ? 40 : 28);
        }
        // Long text is clamped with Show more.
        const long = page.locator(".pending-row").nth(1);
        await expect(long.getByRole("button", { name: "Show more" })).toBeVisible();
        await long.getByRole("button", { name: "Show more" }).click();
        await expect(long.getByRole("button", { name: "Show less" })).toBeVisible();
        await long.getByRole("button", { name: "Show less" }).click();
        // A long list scrolls inside, with a fade, and its last row comes fully into view.
        if (await list.evaluate((el) => el.scrollHeight > el.clientHeight)) {
          await expect(list).toHaveAttribute("data-fade-bottom", "true");
          await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
          await expect(list).not.toHaveAttribute("data-fade-bottom", "true");
          await expect(list).toHaveAttribute("data-fade-top", "true");
          const last = (await page.locator(".pending-row").last().boundingBox())!;
          const shown = (await list.boundingBox())!;
          expect(last.y + last.height).toBeLessThanOrEqual(shown.y + shown.height + 1);
        }
        await page.screenshot({ path: info.outputPath(`queue-${count}-expanded-${colorScheme}.png`) });
        await chip.click();
        await expect(list).toBeHidden();
      }
    }
  });

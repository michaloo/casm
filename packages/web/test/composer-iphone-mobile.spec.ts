import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

// iPhone composer: one scrolling line of pills, and exactly one bottom inset.
for (const [width, height] of [[375, 812], [390, 844]]) test(`iPhone composer pills stay on one line and sit flush at ${width}x${height} mobile`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "provider.catalog") {
        socket.send(JSON.stringify({ id: request.id, result: {
          models: [{ id: "big", name: "A rather long model name", isDefault: true, efforts: ["low", "medium", "high"] }],
          modes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan mode" }, { id: "acceptEdits", name: "Accept edits" }],
        } }));
        return;
      }
      server.send(raw);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("big");
  const row = page.locator(".pickers");
  const pills = row.locator(".composer-picker");
  await expect(pills).toHaveCount(4);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));

  // One line: every pill on the same row, and the row no taller than a pill.
  const boxes = await Promise.all((await pills.all()).map((p) => p.boundingBox()));
  const pill = boxes[0]!;
  for (const box of boxes) expect(Math.abs(box!.y - pill.y)).toBeLessThanOrEqual(0.5);
  const inner = await row.evaluate((el) => el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom));
  expect(inner).toBe(pill.height);
  // It scrolls sideways, fading the edge with more; attach and Send stay put.
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(row).toHaveAttribute("data-more", "end");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const attach = page.getByRole("button", { name: "Attach images", exact: true });
  const [sendBefore, attachBefore] = [(await send.boundingBox())!, (await attach.boundingBox())!];
  await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(row).toHaveAttribute("data-more", "start");
  expect((await send.boundingBox())!.x).toBe(sendBefore.x);
  expect((await attach.boundingBox())!.x).toBe(attachBefore.x);
  await row.evaluate((el) => el.scrollTo({ left: 0 }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

  // The gap under the composer is the safe-area inset (8px minimum), once.
  const inset = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;height:env(safe-area-inset-bottom)";
    document.body.append(probe);
    const value = probe.getBoundingClientRect().height;
    probe.remove();
    return value;
  });
  const gap = async (bottom: number) => {
    const box = (await page.locator("form.composer").boundingBox())!;
    return Math.round(bottom - (box.y + box.height));
  };
  expect(await gap(height)).toBe(Math.max(8, Math.round(inset)));
  await page.screenshot({ path: test.info().outputPath(`iphone-composer-${width}.png`) });

  // Keyboard open: the app follows the visible viewport and drops the inset.
  await page.getByLabel("Message").focus();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", { configurable: true, value: 480 });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
  await expect.poll(() => gap(480)).toBe(8);
  await page.evaluate((height) => {
    Object.defineProperty(visualViewport, "height", { configurable: true, value: height });
    visualViewport!.dispatchEvent(new Event("resize"));
  }, height);
  await expect(page.locator("html")).not.toHaveAttribute("data-keyboard", "open");
  await expect.poll(() => gap(height)).toBe(Math.max(8, Math.round(inset)));

  // Installed on the Home Screen, iOS shrinks innerHeight with the keyboard too.
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 480 });
    Object.defineProperty(visualViewport, "height", { configurable: true, value: 480 });
    visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
  await expect.poll(() => gap(480)).toBe(8);
});

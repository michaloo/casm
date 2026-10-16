import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";
import { openAgents } from "./phone.ts";

// Scrolling up through a long mixed transcript (markdown, code, tools, images,
// Thinking, casm rows) must never show the rows jumping: rows mounting above
// mount at an estimated height and Virtuoso corrects the scroll, but a frame
// painted before that correction moves the screen against the scroll.
async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width < 600) await openAgents(page);
  const row = page.getByRole("button", { name: /Long mixed/ }).first();
  await row.scrollIntoViewIfNeeded();
  if (test.info().project.use.hasTouch) {
    await page.waitForTimeout(250);
    await row.tap();
  } else await row.click();
  await expect(page.getByText("Round 44").first()).toBeVisible();
  // Let the opening pin to the end settle.
  await page.waitForTimeout(500);
}

// Records every painted frame: ResizeObservers report after layout, just
// before paint, in passes over ever deeper boxes, so one made in a first-pass
// callback, watching a deeper box, reports after Virtuoso's own corrections.
// While scrolling up, the row nearest the middle may only move down.
function watchFrames(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!;
    const view = el.getBoundingClientRect();
    const rows = () => new Map([...el.querySelectorAll<HTMLElement>("[data-item-index]")].map((r) => [r.dataset.itemIndex!, r.getBoundingClientRect()]));
    const state = { jumps: [] as { frame: number; moved: number; top: number }[], frames: 0, moved: 0, stop: false };
    (window as unknown as { painted: typeof state }).painted = state;
    const tick = document.body.appendChild(document.createElement("div"));
    tick.style.cssText = "position:fixed;top:0;left:0;height:1px;width:1px;pointer-events:none";
    const deep = tick.appendChild(document.createElement("div"));
    deep.style.cssText = "height:1px;width:1px";
    let before = rows();
    const next = () => requestAnimationFrame(() => {
      const frame = ++state.frames;
      tick.style.width = `${(frame % 2) + 1}px`;
      const first = new ResizeObserver(() => {
        first.disconnect();
        deep.style.width = `${(frame % 2) + 1}px`;
        const painted = new ResizeObserver(() => {
          painted.disconnect();
          const now = rows();
          const middle = view.top + view.height / 2;
          let anchor: string | undefined, best = Infinity;
          for (const [index, box] of now) {
            if (!before.has(index) || box.bottom < view.top || box.top > view.bottom) continue;
            const distance = Math.abs((box.top + box.bottom) / 2 - middle);
            if (distance < best) { best = distance; anchor = index; }
          }
          if (anchor) {
            const moved = now.get(anchor)!.top - before.get(anchor)!.top;
            state.moved += moved;
            if (moved < -1) state.jumps.push({ frame, moved: Math.round(moved), top: Math.round(el.scrollTop) });
          }
          before = now;
          if (state.stop) tick.remove();
          else next();
        });
        painted.observe(deep);
      });
      first.observe(tick);
    });
    next();
  });
}

for (const width of [1440, 375])
  test(`scrolling up never jumps the visible rows at ${width}px mobile`, async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, width);
    await watchFrames(page);
    const scroller = page.locator("[data-virtuoso-scroller]");
    const touch = test.info().project.use.hasTouch;
    if (touch) await scroller.dispatchEvent("touchmove");
    else await scroller.hover();
    // Wheel notches 60ms apart; mobile WebKit has no wheel, so a flick there
    // is a run of shrinking scrolls, one per frame.
    for (let i = 0; i < 60; i++) {
      if (touch)
        await scroller.evaluate(async (el) => {
          for (const part of [30, 25, 20, 15, 10]) {
            el.scrollTop -= part;
            await new Promise(requestAnimationFrame);
          }
        });
      else await page.mouse.wheel(0, -100);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => {
      const state = (window as unknown as { painted: { jumps: { moved: number }[]; moved: number; stop: boolean } }).painted;
      state.stop = true;
      return { jumps: state.jumps, moved: state.moved };
    });
    // It really scrolled, through rows mounting above all the way.
    expect(result.moved).toBeGreaterThan(5000);
    // Virtuoso's iPhone-only path applies a small part of its correction a
    // frame late (its list margin); allow that, not a jump of whole rows.
    expect(result.jumps.filter((j) => j.moved < (touch ? -16 : -1))).toEqual([]);
    // Following stays off and Latest offers the way back.
    const latest = page.getByRole("button", { name: "Latest ↓" });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))).toBeLessThanOrEqual(2);
  });

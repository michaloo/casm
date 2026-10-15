import { readFileSync, writeFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`mobile shared file preview: inline images, zoom, navigation and dismissal at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#168b88"; ctx.fillRect(0, 0, 1600, 1200);
    ctx.fillStyle = "#e5a362"; ctx.fillRect(100, 100, 700, 500); return canvas.toDataURL("image/png").split(",")[1];
  });
  const path = `${testHome}/exports/large.png`;
  writeFileSync(path, Buffer.from(data, "base64"));
  const image = { mediaType: "image/png", data };
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer(), histories = new Set<number>();
    socket.onMessage(raw => { const request = JSON.parse(String(raw)); if (request.method === "agent.history") histories.add(request.id); server.send(raw); });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (histories.delete(response.id)) response.result = { start: 0, items: [
        { kind: "assistant", id: "file", text: `File: ${path}` },
        { kind: "tool", id: "images", name: "view_image", status: "done", input: {}, output: "Useful caption\n[image]\n[Image: source: /home/test/.claude/projects/private.png]", images: [image, image] },
        { kind: "tool", id: "missing", name: "missing_image", status: "done", input: {}, output: "[Image: source: /home/test/.claude/projects/missing.png]" },
        { kind: "user", id: "user-image", text: "My image", images: [image] },
      ] };
      socket.send(JSON.stringify(response));
    });
  });
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.goto(`/h/Test%20host/a/${readFileSync(`${testHome}/web-files-agent-id`, "utf8")}`);
  const tool = page.locator(".item.tool").filter({ hasText: "view_image" });
  await tool.locator("summary").click();
  const thumbnail = tool.getByRole("button", { name: "Open image 1", exact: true });
  await expect(thumbnail).toBeVisible();
  await expect(tool).toContainText("Useful caption");
  await expect(tool).not.toContainText("[image]");
  await expect(tool).not.toContainText("[Image: source:");
  await thumbnail.focus(); await thumbnail.press("Enter");
  const preview = page.locator("dialog.file-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("heading")).toHaveText(/^view_image-.*-1.png$/);
  const surface = preview.locator(".image-surface");
  await expect(surface).toHaveAttribute("data-zoom", "fit");
  const rendered = preview.locator(".file-image");
  await expect.poll(() => rendered.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  const bounds = (await surface.boundingBox())!, fitted = (await rendered.boundingBox())!;
  expect(fitted.width).toBeLessThanOrEqual(bounds.width + 1); expect(fitted.height).toBeLessThanOrEqual(bounds.height + 1);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme }); await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath(`image-preview-${width}-${colorScheme}.png`) });
  }
  await surface.click();
  await expect(surface).toHaveAttribute("data-zoom", "actual");
  expect(Math.round((await rendered.boundingBox())!.width)).toBe(1600);
  await surface.evaluate(el => {
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, clientX: 100, clientY: 100, bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, clientX: 145, clientY: 140, bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, clientX: 145, clientY: 140, bubbles: true }));
  });
  await expect(rendered).not.toHaveCSS("transform", /matrix\(.* 0, 0\)$/);
  await preview.getByRole("button", { name: "Fit", exact: true }).click();
  await surface.evaluate(el => {
    for (const [type, id, x] of [["pointerdown", 20, 100], ["pointerdown", 21, 200], ["pointermove", 21, 300], ["pointerup", 21, 300], ["pointerup", 20, 100]] as const)
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: 150, bubbles: true }));
  });
  await expect(surface).toHaveAttribute("data-zoom", "actual");
  await page.keyboard.press("ArrowRight"); await expect(preview.getByRole("status")).toHaveText("2 / 2");
  await expect(surface).toHaveAttribute("data-zoom", "fit");
  await preview.getByRole("button", { name: "Previous image" }).click();
  await expect(preview.getByRole("status")).toHaveText("1 / 2");
  const download = preview.getByRole("link", { name: "Download" });
  expect(await download.getAttribute("download")).toMatch(/^view_image-.*-1.png$/);
  const [saved] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(saved.suggestedFilename()).toMatch(/^view_image-.*\.png$/);
  if (width === 375) {
    await surface.evaluate(el => {
      el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 100, bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 240, bubbles: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, pointerType: "touch", clientX: 100, clientY: 240, bubbles: true }));
    });
  } else await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await page.locator(".item.user").getByRole("button", { name: "Open image 1" }).click();
  await expect(preview.getByRole("heading")).toHaveText(/^message-.*.png$/);
  await preview.getByRole("button", { name: "Close file preview" }).click();
  const missing = page.locator(".item.tool").filter({ hasText: "missing_image" });
  await missing.locator("summary").click();
  await expect(missing).toContainText("[Image: source:");
  await missing.locator("summary").click();
  await tool.locator("summary").click();
  await page.locator("[data-virtuoso-scroller]").evaluate(el => el.scrollTo({ top: 0, behavior: "instant" }));
  await page.getByRole("link", { name: path, exact: true }).click();
  await expect(preview.getByRole("heading")).toHaveText("large.png");
  await expect(rendered).toBeVisible();
  await preview.getByRole("button", { name: "1:1", exact: true }).click();
  await expect(surface).toHaveAttribute("data-zoom", "actual");
  await preview.getByRole("button", { name: "Close file preview" }).click();

});

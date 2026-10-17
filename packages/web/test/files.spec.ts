// Project files: clickable paths in a transcript, the preview dialog and its
// signed downloads, and the /f/ route.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

const exportsDir = `${testHome}/exports`;
const json = `${exportsDir}/cykelhuset-web-merge.json`;

async function login(page: Page, width: number, path = "/") {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/^Connected$/)).toBeAttached();
  if (path !== "/") await page.goto(path);
}

async function fits(page: Page, dialog: ReturnType<Page["getByRole"]>, width: number) {
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 375) {
    const box = (await dialog.boundingBox())!;
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 375, 812]);
    for (const button of await dialog.locator("button:visible, a.button:visible").all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [1440, 375]) {
  test(`file paths in a transcript open previews and download at ${width}${width === 375 ? " mobile" : ""}`, async ({ page }) => {
    const agentId = readFileSync(`${testHome}/web-files-agent-id`, "utf8");
    await login(page, width, `/h/${encodeURIComponent("Test host")}/a/${agentId}`);
    const reply = page.locator(".item.assistant").filter({ hasText: "Saved the merge" });
    await expect(reply).toBeVisible();
    // Only paths inside a project folder are links.
    await expect(reply.getByRole("link")).toHaveCount(2);
    await expect(reply.getByRole("link", { name: "/etc/passwd" })).toHaveCount(0);

    // Prose: JSON pretty-printed and highlighted.
    await reply.getByRole("link", { name: json, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "File cykelhuset-web-merge.json" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("pre")).toContainText('"merged": [\n    {\n      "id": 1,');
    await expect(dialog.locator("pre .hljs-attr").first()).toBeVisible();
    // Phones keep the path and meta behind the name until asked.
    if (width === 375) {
      await expect(dialog.locator(".file-meta")).toBeHidden();
      const head = (await dialog.locator("header").boundingBox())!;
      expect(head.height).toBeLessThanOrEqual(64);
      expect((await dialog.locator(".file-preview-body").boundingBox())!.y).toBeLessThanOrEqual(70);
      await dialog.getByRole("button", { name: "File details" }).click();
    }
    await expect(dialog.locator(".file-meta")).toBeVisible();
    await expect(dialog.locator(".file-meta")).toContainText("application/json");
    await expect(dialog.locator(".settings-path")).toHaveText(json);
    await expect(page).toHaveURL(new RegExp(`/a/${agentId}$`));

    // The link is signed and short-lived; the response is an attachment.
    const download = dialog.getByRole("link", { name: "Download", exact: true });
    const href = (await download.getAttribute("href"))!;
    expect(href).toMatch(/^\/dl\/[\w-]+\.[\w-]+\/cykelhuset-web-merge\.json$/);
    expect(href).not.toContain(readFileSync(`${testHome}/web-token`, "utf8"));
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers()["content-disposition"]).toBe(`attachment; filename="cykelhuset-web-merge.json"; filename*=UTF-8''cykelhuset-web-merge.json`);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    expect(JSON.parse(await res.text()).merged[0].name).toBe("Cykelhuset");
    const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
    expect(file.suggestedFilename()).toBe("cykelhuset-web-merge.json");
    expect(readFileSync((await file.path())!, "utf8")).toContain("Cykelhuset");

    await dialog.getByRole("button", { name: "Copy path" }).click();
    await expect(dialog.getByRole("button", { name: /Copied|Select to copy/ })).toBeVisible();
    await fits(page, dialog, width);
    await page.screenshot({ path: `/tmp/casm-file-preview-${width}-${test.info().project.name}.png` });
    await dialog.getByRole("button", { name: "Close file preview" }).click();
    await expect(dialog).toHaveCount(0);

    // Inline code: markdown rendered.
    await reply.locator("a.file-link code").click();
    const notes = page.getByRole("dialog", { name: "File notes.md" });
    await expect(notes.getByRole("heading", { name: "Import notes" })).toBeVisible();
    await notes.getByRole("button", { name: "Close file preview" }).click();

    // Tool output: an image shown inline, then a binary file's info.
    const tool = page.locator(".item.tool").filter({ hasText: "Bash" });
    await tool.locator("summary").click();
    await tool.getByRole("link", { name: `${exportsDir}/pixel.png` }).click();
    const image = page.getByRole("dialog", { name: "File pixel.png" }).getByRole("img", { name: "pixel.png" });
    await expect(image).toBeVisible();
    expect(await image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    const inline = await page.request.get((await image.getAttribute("src"))!);
    expect(inline.headers()["content-disposition"]).toMatch(/^inline; /);
    expect(inline.headers()["content-type"]).toBe("image/png");
    await page.getByRole("button", { name: "Close file preview" }).click();
    await tool.getByRole("link", { name: `${exportsDir}/blob.bin` }).click();
    await expect(page.getByRole("dialog", { name: "File blob.bin" })).toContainText("Binary file · 4 B");
  });

  test(`the /f/ route previews a pasted path at ${width}${width === 375 ? " mobile" : ""}`, async ({ page }) => {
    await login(page, width, `/f${exportsDir}/notes.md`);
    const dialog = page.getByRole("dialog", { name: "File notes.md" });
    await expect(dialog.getByRole("heading", { name: "Import notes" })).toBeVisible();
    await fits(page, dialog, width);
    await dialog.getByRole("button", { name: "Close file preview" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/f/etc/passwd");
    await expect(page.getByRole("dialog", { name: "File passwd" }).getByRole("alert")).toContainText("not inside a project folder");
    // A folder is not browsed; the preview says so.
    await page.goto(`/f${exportsDir}`);
    const folder = page.locator("dialog.file-preview");
    await expect(folder).toHaveAccessibleName("File exports");
    await expect(folder).toContainText("This is a folder.");
    await expect(folder.getByRole("list")).toHaveCount(0);
  });
}

for (const width of [1440, 375]) {
  test(`file links with a line open the file and highlight it at ${width}`, async ({ page }) => {
    const agentId = readFileSync(`${testHome}/web-files-agent-id`, "utf8");
    await login(page, width, `/h/${encodeURIComponent("Test host")}/a/${agentId}`);
    const reply = page.locator(".item.assistant").filter({ hasText: "See " });
    await reply.getByRole("link", { name: `${exportsDir}/lines.ts:40:5` }).click();
    const dialog = page.getByRole("dialog", { name: "File lines.ts" });
    await expect(dialog.locator(".settings-path")).toHaveText(`${exportsDir}/lines.ts`);
    const mark = dialog.locator(".line-mark");
    await expect(mark).toHaveAttribute("data-line", "40");
    await expect(dialog.locator("pre")).toContainText("line40 = 40");
    const inView = async (n: number) => {
      const text = dialog.getByText(`line${n} = ${n}`).first();
      const [m, t] = await Promise.all([mark.boundingBox(), text.boundingBox()]);
      expect(Math.abs(m!.y + m!.height / 2 - (t!.y + t!.height / 2))).toBeLessThan(t!.height);
      const body = (await dialog.locator(".file-preview-body").boundingBox())!;
      expect(m!.y).toBeGreaterThanOrEqual(body.y - 1);
      expect(m!.y + m!.height).toBeLessThanOrEqual(body.y + body.height + 1);
    };
    await inView(40);
    await fits(page, dialog, width);
    await dialog.getByRole("button", { name: "Close file preview" }).click();
    await reply.getByRole("link", { name: "the helper" }).click();
    await expect(page.getByRole("dialog", { name: "File lines.ts" }).locator(".line-mark")).toHaveAttribute("data-line", "90");
    await inView(90);
    await page.getByRole("button", { name: "Close file preview" }).click();
    // The /f/ route takes the suffix too.
    await page.goto(`/f${exportsDir}/lines.ts:75`);
    await expect(page.getByRole("dialog", { name: "File lines.ts" }).locator(".line-mark")).toHaveAttribute("data-line", "75");
    await inView(75);
  });

  test(`html files render in a sandboxed frame with a source toggle at ${width}`, async ({ page }) => {
    await login(page, width, `/f${exportsDir}/page.html`);
    const dialog = page.getByRole("dialog", { name: "File page.html" });
    const frame = dialog.locator("iframe.file-html-frame");
    await expect(frame).toBeVisible();
    // No allow-same-origin: the page cannot reach casm's origin.
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    const inner = page.frameLocator("iframe.file-html-frame");
    await expect(inner.locator("h1")).toHaveText("Rendered page");
    await expect(inner.locator("h1")).toHaveAttribute("data-js", "ran");
    await expect(inner.locator("h1")).toHaveAttribute("data-blocked", "yes");
    await expect(dialog.locator(".file-note.muted")).toContainText("next to it");
    await expect(dialog.getByRole("button", { name: "Rendered" })).toHaveAttribute("aria-pressed", "true");
    await fits(page, dialog, width);
    await dialog.getByRole("button", { name: "Source" }).click();
    await expect(frame).toHaveCount(0);
    await expect(dialog.locator("pre")).toContainText("<h1 id=\"hi\">Rendered page</h1>");
    await fits(page, dialog, width);
    await expect(dialog.getByRole("link", { name: "Download", exact: true })).toBeVisible();
  });
}

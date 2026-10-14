// Project files: clickable paths in a transcript, the preview dialog and its
// signed downloads, the project settings Files tab and the /f/ route.
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
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

  test(`project Files tab browses, previews and downloads at ${width}${width === 375 ? " mobile" : ""}`, async ({ page }) => {
    await login(page, width);
    if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Settings for Test project", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Test project project settings" });
    await panel.getByRole("button", { name: "Files", exact: true }).click();
    const list = panel.getByRole("list", { name: /^Files in / });
    await expect(list).toBeVisible();
    const names = await list.locator(".file-name").allTextContents();
    // Folders first, then files; hidden ones are listed and marked.
    expect(names.indexOf("exports/")).toBeGreaterThanOrEqual(0);
    expect(names.findIndex((n) => !n.includes("/"))).toBeGreaterThan(names.indexOf("exports/"));
    await expect(list.locator(".hidden-file").filter({ hasText: ".hidden-config" })).toContainText("hidden");
    // The server's state directory is listed but never opened.
    await list.getByRole("button", { name: /^state\// }).click();
    await expect(panel.getByRole("alert")).toContainText("casm's state directory");
    await panel.getByRole("navigation", { name: "Folder path" }).getByRole("button").first().click();
    await list.getByRole("button", { name: /^exports\// }).click();
    await expect(panel.getByRole("navigation", { name: "Folder path" })).toContainText("exports");
    await panel.getByRole("list", { name: "Files in exports" }).getByRole("button", { name: /^nested\// }).click();
    await panel.getByRole("button", { name: /^deep\.txt/ }).click();
    const preview = page.getByRole("dialog", { name: "File deep.txt" });
    await expect(preview.locator("pre")).toHaveText("deep\n");
    const res = await page.request.get((await preview.getByRole("link", { name: "Download" }).getAttribute("href"))!);
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="deep.txt"/);
    expect(await res.text()).toBe("deep\n");
    await fits(page, preview, width);
    await preview.getByRole("button", { name: "Close file preview" }).click();
    // Breadcrumbs lead back up.
    await panel.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "exports", exact: true }).click();
    await expect(panel.getByRole("list", { name: "Files in exports" })).toBeVisible();
    await panel.getByRole("button", { name: /^\.\. *Parent folder/ }).click();
    await expect(list.getByRole("button", { name: /^exports\// })).toBeVisible();
    await fits(page, panel, width);
    await page.screenshot({ path: `/tmp/casm-files-tab-${width}-${test.info().project.name}.png` });
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
    // A folder previews as a listing.
    await page.goto(`/f${exportsDir}`);
    const folder = page.locator("dialog.file-preview");
    await expect(folder).toHaveAccessibleName("File exports");
    await folder.getByRole("button", { name: /^notes\.md/ }).click();
    await expect(folder.getByRole("heading", { name: "Import notes" })).toBeVisible();
    await folder.getByRole("button", { name: "Back", exact: true }).click();
    await expect(folder.getByRole("button", { name: /^notes\.md/ })).toBeVisible();
    await expect(folder).toHaveAccessibleName("File exports");
  });
}

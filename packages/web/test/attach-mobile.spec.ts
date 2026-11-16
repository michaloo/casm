import { testHome } from "./config.ts";
import { readFileSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, openNewAgent } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const thumbs = (page: Page) => page.locator("form.composer .image-attachments img");

async function login(page: Page, width: number) {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await openAgents(page);
}

// Runs in the page: a File, optionally a large noisy photo that must be downscaled.
async function transfer(page: Page, kind: "small" | "large", type: "paste" | "drop" | "dragover", text = "") {
  await page.evaluate(async ({ png, kind, type, text }) => {
    let file: File;
    if (kind === "small") file = new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "tiny.png", { type: "image/png" });
    else {
      const canvas = document.createElement("canvas");
      canvas.width = 3000; canvas.height = 1500;
      const context = canvas.getContext("2d")!;
      const pixels = context.createImageData(3000, 1500);
      for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0;
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/png"));
      file = new File([blob], "photo.png", { type: "image/png" });
    }
    const data = new DataTransfer();
    data.items.add(file);
    if (text) data.setData("text/plain", text);
    if (type === "paste") document.querySelector('textarea[aria-label="Message"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    else document.querySelector("form.composer")!.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { png, kind, type, text });
}

for (const width of [1440, 375]) test(`attach images by picker, paste and drop, then remove at ${width}px mobile`, async ({ page }) => {
  await login(page, width);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  const attach = page.getByRole("button", { name: "Attach files", exact: true });
  await expect(attach).toBeEnabled();
  const box = (await attach.boundingBox())!;
  if (width === 375) expect([box.width, box.height]).toEqual([44, 44]);
  else expect(box.height).toBe(32);

  // The picker: any file, several at once.
  const chooser = page.waitForEvent("filechooser");
  await attach.click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  expect(await picker.element().getAttribute("accept")).toBeNull();
  const bytes = Buffer.from(png, "base64");
  await picker.setFiles([{ name: "one.png", mimeType: "image/png", buffer: bytes }, { name: "two.png", mimeType: "image/png", buffer: bytes }]);
  await expect(thumbs(page)).toHaveCount(2);
  expect(await thumbs(page).first().getAttribute("src")).toBe(`data:image/png;base64,${png}`);

  // Paste: the file is read once (files and items both list it), and the text still lands.
  await page.getByLabel("Message").fill("see ");
  await page.getByLabel("Message").evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
  await transfer(page, "small", "paste", "attached");
  await expect(thumbs(page)).toHaveCount(3);
  await expect(page.getByLabel("Message")).toHaveValue("see attached");

  // Drop: the composer highlights while a file is over it.
  await transfer(page, "small", "dragover");
  await expect(page.locator("form.composer")).toHaveClass(/dropping/);
  await transfer(page, "small", "drop");
  await expect(page.locator("form.composer")).not.toHaveClass(/dropping/);
  await expect(thumbs(page)).toHaveCount(4);

  // Remove buttons: one per thumbnail, a 44px target on phones.
  const remove = page.getByRole("button", { name: "Remove image 2" });
  if (width === 375) {
    const r = (await remove.boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(32);
  }
  await remove.click();
  await expect(thumbs(page)).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.locator("form.composer").screenshot({ path: test.info().outputPath(`composer-attachments-${width}.png`) });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thumbs(page)).toHaveCount(0);
  await expect(page.locator(".item.user").last().locator("img")).toHaveCount(3);
});

for (const width of [1440, 375]) test(`large photos are downscaled; the new-agent draft takes images at ${width}px mobile`, async ({ page }) => {
  await login(page, width);
  await openNewAgent(page);
  await transfer(page, "large", "drop");
  await expect(thumbs(page)).toHaveCount(1, { timeout: 15000 });
  const image = await thumbs(page).first().evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight, src: img.src.slice(0, 23), length: img.src.length }));
  expect([image.width, image.height]).toEqual([2000, 1000]);
  // Noise as PNG would be ~12 MB; it becomes a JPEG well under the limit.
  expect(image.src).toBe("data:image/jpeg;base64,");
  expect(image.length).toBeLessThan(5 * 1024 * 1024 * 4 / 3);
  // The new agent gets the downscaled image (the fixture's new agents echo only text).
  await page.evaluate(() => {
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const message = JSON.parse(String(data));
      if (message.method === "agent.send") (window as any).sentImages = message.params.images.map((i: { mediaType: string }) => i.mediaType);
      return original.call(this, data);
    };
  });
  await page.getByLabel("Message").fill("a photo for a new agent");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/a\//);
  await expect.poll(() => page.evaluate(() => (window as any).sentImages)).toEqual(["image/jpeg"]);
  await expect(thumbs(page)).toHaveCount(0);
});

for (const width of [1440, 375]) test(`other files are saved in the project folder and show as chips at ${width}px mobile`, async ({ page }) => {
  await login(page, width);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  const name = `notes-${width}-${test.info().project.name}.csv`;
  // A test home kept from an earlier run would make it "(1)".
  rmSync(`${testHome}/${name}`, { force: true });
  await page.evaluate((name) => {
    const data = new DataTransfer();
    data.items.add(new File(["a,b\n1,2\n"], name, { type: "text/csv" }));
    document.querySelector("form.composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, name);
  const chips = page.locator("form.composer .file-attachments li");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText(name);
  await expect(chips.first()).toContainText("8 B");
  await expect(thumbs(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.locator("form.composer").screenshot({ path: test.info().outputPath(`composer-files-${width}.png`) });
  await page.getByLabel("Message").fill("sum column b");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chips).toHaveCount(0);
  // The transcript shows the text and a chip linking to the saved file, not the line.
  const sent = page.locator(".item.user").filter({ hasText: "sum column b" }).last();
  const link = sent.locator("a.file-attachment");
  await expect(link).toHaveAttribute("href", `/f${testHome}/${name}`);
  await expect(sent).not.toContainText("Attached file:");
  expect(readFileSync(`${testHome}/${name}`, "utf8")).toBe("a,b\n1,2\n");
});

test("a file over 50 MB is refused with a clear message", async ({ page }) => {
  await login(page, 1440);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    // Sparse: only its size matters.
    data.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], "huge.zip", { type: "application/zip" }));
    document.querySelector("form.composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("alert")).toContainText("huge.zip is 50.0 MB, over the 50 MB limit for a file attachment.");
  await expect(page.locator("form.composer .file-attachments li")).toHaveCount(0);
});

// The draft-file records in IndexedDB, by draft key: how many files each holds.
const storedDrafts = (page: Page) => page.evaluate(() => new Promise<number[]>((done) => {
  const open = indexedDB.open("casm-drafts", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("files");
  open.onsuccess = () => {
    const r = open.result.transaction("files").objectStore("files").getAll();
    r.onsuccess = () => { done(r.result.map((x: { files: unknown[] }) => x.files.length)); open.result.close(); };
  };
}));

test("draft files survive a reload and are cleared when sent or removed", async ({ page }) => {
  await login(page, 1440);
  await page.getByRole("button", { name: /Agent 01/ }).click();
  const name = `kept-${test.info().project.name}.log`;
  rmSync(`${testHome}/${name}`, { force: true });
  const drop = (file: string) => page.evaluate((file) => {
    const data = new DataTransfer();
    data.items.add(new File(["line one\n"], file, { type: "text/plain" }));
    document.querySelector("form.composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, file);
  const chips = page.locator("form.composer .file-attachments li");
  await drop(name);
  await page.getByLabel("Message").fill("check the log");
  await expect.poll(() => storedDrafts(page)).toEqual([1]);

  await page.reload();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText(name);
  await expect(page.getByLabel("Message")).toHaveValue("check the log");

  // Removing the chip deletes the stored file.
  await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expect.poll(() => storedDrafts(page)).toEqual([]);
  await drop(name);
  await expect.poll(() => storedDrafts(page)).toEqual([1]);

  // Sending uploads the restored file and clears the record.
  await page.reload();
  await expect(chips).toHaveCount(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chips).toHaveCount(0);
  await expect(page.locator(".item.user").filter({ hasText: "check the log" }).last().locator("a.file-attachment")).toHaveAttribute("href", `/f${testHome}/${name}`);
  expect(readFileSync(`${testHome}/${name}`, "utf8")).toBe("line one\n");
  await expect.poll(() => storedDrafts(page)).toEqual([]);
});

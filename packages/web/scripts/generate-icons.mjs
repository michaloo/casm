// Deterministic resizing/compositing of the checked-in Apple brand artwork.
// Run from any directory: node packages/web/scripts/generate-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
const source = await readFile(new URL("../../../brand/casm-icon-light-1024.png", import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [name, size, scale] of [
    ["apple-touch-icon.png", 180, 1], ["icon-192.png", 192, 1], ["icon-512.png", 512, 1],
    ["icon-maskable-192.png", 192, .7], ["icon-maskable-512.png", 512, .7],
  ]) {
    const png = await page.evaluate(async ({ data, size, scale }) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fffaf4"; ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingQuality = "high";
      // Maskable artwork stays within the central 80%-diameter safe circle.
      const edge = (1 - scale) * size / 2;
      ctx.drawImage(image, edge, edge, size * scale, size * scale);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { data: source.toString("base64"), size, scale });
    await writeFile(new URL(`../public/${name}`, import.meta.url), Buffer.from(png, "base64"));
  }
} finally { await browser.close(); }

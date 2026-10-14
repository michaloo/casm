import { test, expect } from "@playwright/test";
import { testHome, testURL } from "./config.ts";

test("PWA mobile manifest, Apple metadata and opaque install icons", async ({ page, request }) => {
  await page.goto("/");
  for (const [name, value] of [["apple-mobile-web-app-capable", "yes"], ["mobile-web-app-capable", "yes"], ["apple-mobile-web-app-title", "casm"], ["apple-mobile-web-app-status-bar-style", "black-translucent"]])
    await expect(page.locator(`meta[name="${name}"]`)).toHaveAttribute("content", value);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("sizes", "180x180");
  for (const [scheme, color] of [["light", "#fffaf4"], ["dark", "#0b141a"]]) {
    await page.emulateMedia({ colorScheme: scheme as "light" | "dark" });
    await expect(page.locator(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`)).toHaveAttribute("content", color);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");
  }
  const response = await request.get("/manifest.webmanifest");
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  expect(response.headers()["cache-control"]).toBe("no-cache");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: "/", name: "casm", short_name: "casm", display: "standalone", start_url: "/", scope: "/", theme_color: "#fffaf4", background_color: "#fffaf4" });
  for (const purpose of ["any", "maskable"]) for (const size of [192, 512]) expect(manifest.icons).toContainEqual(expect.objectContaining({ purpose, sizes: `${size}x${size}`, type: "image/png" }));
  for (const icon of [{ src: "/apple-touch-icon.png", sizes: "180x180" }, ...manifest.icons]) {
    const result = await page.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = true; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) opaque = false;
      return { sizes: `${canvas.width}x${canvas.height}`, opaque };
    }, icon.src);
    expect(result).toEqual({ sizes: icon.sizes, opaque: true });
    const image = await request.get(icon.src);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(image.headers()["cache-control"]).toBe("no-cache");
  }
});

test("PWA mobile plain remote HTTP stays usable without registering a worker", async ({ page }) => {
  const origin = "http://casm-insecure.test";
  const workerRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/sw.js")) workerRequests.push(request.url()); });
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await page.request.get(`${testURL}${url.pathname}${url.search}`) });
  });
  await page.goto(origin);
  await expect(page.getByLabel("Server token")).toBeVisible();
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.waitForTimeout(200);
  expect(workerRequests).toEqual([]);
  expect(await page.evaluate(async () => "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0)).toBe(0);
});

test("PWA mobile localhost worker serves only the offline shell", async ({ page, context, request }) => {
  await page.goto("/");
  expect(await page.evaluate(() => isSecureContext)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const registration = await page.evaluate(async () => {
    const value = await navigator.serviceWorker.ready;
    return { scope: value.scope, script: value.active?.scriptURL, update: value.updateViaCache };
  });
  expect(registration.scope).toBe(`${testURL}/`);
  expect(registration.script).toBe(`${testURL}/sw.js`);
  expect(registration.update).toBe("none");
  const worker = await request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("javascript");
  expect(worker.headers()["cache-control"]).toBe("no-cache");
  await page.evaluate(async () => { await fetch("/health"); await fetch("/dl/not-a-real-download?token=private"); });
  const paths = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith("casm-shell-"));
    return { names, paths: (await (await caches.open(names[0])).keys()).map(request => new URL(request.url).pathname) };
  });
  expect(paths.names).toHaveLength(1);
  expect(paths.names[0]).toMatch(/^casm-shell-[0-9a-f]{20}$/);
  expect(paths.paths).toContain("/index.html");
  expect(paths.paths.some(path => path.startsWith("/assets/") && path.endsWith(".js"))).toBe(true);
  expect(paths.paths.every(path => path.startsWith("/assets/") || /^\/(index.html|manifest.webmanifest|favicon\.(svg|png)|apple-touch-icon.png|icon-(maskable-)?(192|512).png)$/.test(path))).toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Server token")).toBeVisible();
  expect(await page.evaluate(async () => { try { await fetch("/health"); return true; } catch { return false; } })).toBe(false);
  await context.setOffline(false);
});


test("PWA mobile Vite serves install assets without a development worker", async ({ page }) => {
  const { createServer } = await import("vite");
  const { resolve } = await import("node:path");
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    cacheDir: `${testHome}/pwa-vite-cache`,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  try {
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    await expect(page.getByLabel("Server token")).toBeVisible();
    const manifest = await page.request.get(`${origin}/manifest.webmanifest`);
    expect(manifest.headers()["content-type"]).toContain("manifest+json");
    expect(await manifest.json()).toMatchObject({ id: "/", display: "standalone" });
    const icon = await page.request.get(`${origin}/apple-touch-icon.png`);
    expect(icon.headers()["content-type"]).toContain("image/png");
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  } finally {
    await vite.close();
  }
});

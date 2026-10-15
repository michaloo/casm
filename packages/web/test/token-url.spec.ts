import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

// The token never travels in a URL, where proxies, server logs and browser
// history would keep it: the WebSocket's first message carries it instead.
test("no request URL carries the token; the socket's first message does", async ({ page, context }) => {
  const token = readFileSync(`${testHome}/web-token`, "utf8").trim();
  const urls: string[] = [];
  const firstFrames: string[] = [];
  context.on("request", (r) => urls.push(r.url()));
  page.on("websocket", (ws) => {
    urls.push(ws.url());
    let first = true;
    ws.on("framesent", (f) => {
      if (first) firstFrames.push(String(f.payload));
      first = false;
    });
  });

  await page.goto("/");
  await page.getByLabel("Server token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Test project").first()).toBeVisible();
  // A reload reconnects with the saved token.
  await page.reload();
  await expect(page.getByText("Test project").first()).toBeVisible();

  expect(urls.some((u) => u.startsWith("ws"))).toBe(true);
  for (const u of urls) {
    expect(u).not.toContain(token);
    expect(u).not.toContain(encodeURIComponent(token));
    expect(u).not.toMatch(/[?&]token=/);
  }
  expect(firstFrames.length).toBeGreaterThanOrEqual(2);
  for (const f of firstFrames) expect(JSON.parse(f)).toMatchObject({ method: "auth", params: { token } });
});

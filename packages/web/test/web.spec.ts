import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
async function login(page: any) {
  await page.goto("/");
  await page
    .getByLabel("Server token")
    .fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByLabel("Message")).toBeVisible();
  await expect(page.getByText("Message 319", { exact: false })).toBeVisible();
}
async function send(page: any, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue("");
}
test("every sidebar row selects, pending never hides composer, send/steer/interrupt and permission", async ({
  page,
}) => {
  await login(page);
  for (let i = 0; i < 65; i++) {
    const name = `Agent ${String(i).padStart(2, "0")}`;
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.locator("main header strong")).toHaveText(name);
  }
  await send(page, "hello");
  await expect(page.getByText("echo: hello", { exact: true })).toBeVisible();
  await send(page, "slow");
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 22; i++) await send(page, `queued ${i}`);
  await expect(page.locator(".pending-row")).toHaveCount(22);
  await page.screenshot({ path: "/tmp/casm-web-desktop.png" });
  const box = await page.getByLabel("Message").boundingBox();
  expect(box!.y + box!.height).toBeLessThan(900);
  await page.getByLabel("Message").fill("steered");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(page.getByText("echo: steered", { exact: true })).toBeVisible();
  await page
    .locator(".pending-row")
    .first()
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.locator(".pending-row")).toHaveCount(21);
  await page
    .locator(".pending-row")
    .first()
    .getByRole("button", { name: "Send now", exact: true })
    .click();
  await expect(page.locator(".pending-row")).toHaveCount(0);
  await send(page, "slow");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toHaveCount(0);
  await send(page, "permission");
  await expect(page.getByText("Permission: Write")).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    page.getByText("echo: permission", { exact: true }),
  ).toBeVisible();
  await send(page, "question");
  await page.getByLabel("Choose color").selectOption("Blue");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.getByText("echo: question", { exact: true })).toBeVisible();
});
test("streaming and history pagination keep reader position; reconnect and new agent", async ({
  page,
}) => {
  await login(page);
  process.kill(
    Number(readFileSync("/tmp/casm-web-dev/web-pid", "utf8")),
    "SIGUSR2",
  );
  await expect(
    page.locator("main .error").getByText("Offline", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("aside footer")).toContainText("Connected");
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await send(page, "stream");
  await expect(page.getByText(/Streaming line/).first()).toBeVisible();
  const scroller = page.locator("[data-virtuoso-scroller]");
  await scroller.hover();
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(200);
  const before = await scroller.evaluate((el: any) => el.scrollTop);
  await page.waitForTimeout(1200);
  const after = await scroller.evaluate((el: any) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(5);
  await scroller.evaluate((el: any) => {
    el.scrollTop = 0;
  });
  // Prepending older messages preserves the current first row, shifting scrollTop.
  await expect
    .poll(() => scroller.evaluate((el: any) => el.scrollTop))
    .toBeGreaterThan(100);
  await scroller.evaluate((el: any) => {
    el.scrollTop = 0;
  });
  await expect(page.getByText(/Message 1[0-9][0-9]/).first()).toBeVisible();
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await page.getByRole("button", { name: "Test project" }).click();
  await send(page, "new conversation");
  await expect(page.locator("main header strong")).toHaveText(
    "new conversation",
  );
  await expect(
    page.getByText("echo: new conversation", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /new conversation/ }),
  ).toBeVisible();
});
test("mobile composer and pending stay inside viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page
    .getByLabel("Server token")
    .fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await send(page, "slow");
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 14; i++) await send(page, `mobile pending ${i}`);
  const box = await page.getByLabel("Message").boundingBox();
  expect(box!.y + box!.height).toBeLessThan(812);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await page.screenshot({ path: "/tmp/casm-web-mobile.png" });
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
});

test("URL and per-agent drafts survive reload, switching and Back/Forward", async ({
  page,
}) => {
  await login(page);
  const first = page.url();
  expect(new URL(first).pathname).toMatch(/^\/h\/Test%20host\/a\//);
  await page.getByLabel("Message").fill("Draft for the first agent");
  // Reload immediately, before the debounce expires; pagehide flushes it.
  await page.reload();
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await expect(page.getByLabel("Message")).toHaveValue(
    "Draft for the first agent",
  );
  await page.getByRole("button", { name: /Agent 01/ }).click();
  const second = page.url();
  expect(second).not.toBe(first);
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.getByLabel("Message").fill("Draft for another agent");
  await page.reload();
  await expect(page.locator("main header strong")).toHaveText("Agent 01");
  await expect(page.getByLabel("Message")).toHaveValue(
    "Draft for another agent",
  );
  await page.goBack();
  await expect(page.locator("main header strong")).toHaveText("Agent 00");
  await expect(page.getByLabel("Message")).toHaveValue(
    "Draft for the first agent",
  );
  await page.goForward();
  await expect(page.locator("main header strong")).toHaveText("Agent 01");
  await expect(page.getByLabel("Message")).toHaveValue(
    "Draft for another agent",
  );
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.reload();
  await expect(page.locator("main header strong")).toHaveText("Agent 01");
  await expect(page.getByLabel("Message")).toHaveValue("");
});

test("new-agent draft restores its project URL, then clears on first successful send", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Test project" }).click();
  const draftURL = page.url();
  expect(new URL(draftURL).pathname).toMatch(/\/p\/[^/]+\/new$/);
  await page.getByLabel("Message").fill("A saved new agent draft");
  await page.reload();
  await expect(page.locator("main header strong")).toHaveText("Test project");
  await expect(page.getByLabel("Message")).toHaveValue(
    "A saved new agent draft",
  );
  await page.getByLabel("Message").press("Enter");
  await expect(page.locator("main header strong")).toHaveText(
    "A saved new agent draft",
  );
  await expect(page).toHaveURL(/\/a\/[^/]+$/);
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.reload();
  await expect(page.locator("main header strong")).toHaveText(
    "A saved new agent draft",
  );
  await expect(page.getByLabel("Message")).toHaveValue("");
  await page.goto(draftURL);
  await expect(page.getByLabel("Message")).toHaveValue("");
});

test("failed sends retain drafts and missing routes show not found", async ({
  page,
}) => {
  await page.routeWebSocket("**/*", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.send")
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 1002, message: "Test send failure" },
          }),
        );
      else server.send(raw);
    });
  });
  await login(page);
  await page.getByLabel("Message").fill("Keep this after a failed send");
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByRole("alert")).toContainText("Test send failure");
  await page.reload();
  await expect(page.getByLabel("Message")).toHaveValue(
    "Keep this after a failed send",
  );
  await page.goto("/h/Test%20host/a/does-not-exist");
  await expect(page.getByRole("alert")).toContainText("Agent not found");
  await expect(page.getByLabel("Message")).toHaveCount(0);
  const archivedId = readFileSync("/tmp/casm-web-dev/web-archived-id", "utf8");
  await page.goto(`/h/Test%20host/a/${archivedId}`);
  await expect(page.getByRole("alert")).toContainText("Agent not found");
  await page.goto("/h/missing-host/a/does-not-exist");
  await expect(page.getByRole("alert")).toContainText("Host not found");
});

test("Vite SPA fallback restores a deep-linked agent on an isolated dev server", async ({
  page,
}) => {
  const { createServer } = await import("vite");
  const { resolve } = await import("node:path");
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    cacheDir: "/tmp/casm-web-dev/vite-cache",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  try {
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    await login(page);
    const route = new URL(page.url()).pathname;
    await page.addInitScript(
      (token) => localStorage.setItem("casm.token", token),
      readFileSync("/tmp/casm-web-dev/web-token", "utf8"),
    );
    const response = await page.goto(
      `http://127.0.0.1:${address.port}${route}?server=ws://127.0.0.1:7495`,
    );
    expect(response!.status()).toBe(200);
    await expect(page.locator("main header strong")).toHaveText("Agent 00");
  } finally {
    await vite.close();
  }
});

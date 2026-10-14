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
  await expect(page.getByText(/Streaming line/)).toBeVisible();
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

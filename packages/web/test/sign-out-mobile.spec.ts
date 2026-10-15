import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

// Signing out deletes the token and the offline copy, so it always asks first.
for (const width of [1440, 375]) test(`sign out asks first; Cancel and Escape keep the session at ${width}px mobile`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const sidebar = async () => { if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click(); };
  await sidebar();
  await expect(page.getByRole("button", { name: "Token", exact: true })).toHaveCount(0);
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  if (width === 375) expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // A single click only asks; Cancel is focused and keeps the session.
  await signOut.click();
  const confirm = page.getByRole("alertdialog", { name: "Sign out of Test host on this device?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("You'll need the token to sign in again. Saved offline chats on this device are deleted.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("casm.token"))).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath(`sign-out-${width}.png`) });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(signOut).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("casm.token"))).toBeTruthy();
  await expect(page.getByLabel("Server token")).toHaveCount(0);

  // Escape cancels too, and Enter on the focused Cancel does nothing harmful.
  await signOut.click();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await signOut.click();
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("casm.token"))).toBeTruthy();

  // Confirming signs out.
  await signOut.click();
  await confirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Server token")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("casm.token"))).toBeNull();
});

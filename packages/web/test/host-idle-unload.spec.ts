import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { openAgents } from "./phone.ts";

const config = () => { try { return JSON.parse(readFileSync(`${testHome}/state/config.json`, "utf8")); } catch { return {}; } };

test("Resources sets how long idle agents keep their process", async ({ page }, info) => {
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: "Host options for Test host", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Test host host" });
  await dialog.getByRole("button", { name: "Resources", exact: true }).click();
  const select = dialog.getByRole("region", { name: "Resources" }).getByRole("combobox", { name: "Unload idle agents" });
  const before = config().idleUnloadMinutes ?? 15;
  try {
    await expect(select).toHaveValue(String(before));
    await dialog.screenshot({ path: info.outputPath("idle-unload.png") });
    await select.selectOption({ label: "Never" });
    await expect.poll(() => config().idleUnloadMinutes).toBe(0);
    await select.selectOption({ label: "After 1 h idle" });
    await expect.poll(() => config().idleUnloadMinutes).toBe(60);
    await expect(select).toBeEnabled();
  } finally {
    await select.selectOption(String(before));
    await expect.poll(() => config().idleUnloadMinutes).toBe(before);
  }
});

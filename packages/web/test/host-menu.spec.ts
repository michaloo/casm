import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

for (const width of [1440, 375]) test(`host row opens the host modal and edits schedules at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  const updatedTargets: unknown[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "schedule.create") {
        if (request.params.target.type === "agent") request.params.target.whenBusy = "skip";
        else request.params.target.config = { model: "fixture-model" };
      }
      if (request.method === "schedule.update" && request.params.target) updatedTargets.push(request.params.target);
      server.send(JSON.stringify(request));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  // The header only folds; ⋯ opens the host modal, + a new project. Status stays off the row, in its tooltip.
  const fold = page.getByRole("button", { name: "Toggle Test host host", exact: true });
  await expect(fold.locator(".host-dot.online")).toHaveCount(1);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(fold).toHaveAccessibleDescription(/Online/);
  const trigger = page.getByRole("button", { name: "Host options for Test host", exact: true });
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  const plus = page.getByRole("button", { name: "New project on Test host", exact: true });
  await expect(plus).toHaveAttribute("title", "New project");
  await expect(fold).toHaveAttribute("title", "Test host · Online");
  await expect(fold.locator("small")).toHaveCount(0);
  await expect(page.locator("nav .host-heading").first().getByRole("button")).toHaveCount(3);
  if (width === 375) for (const button of [trigger, plus]) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await trigger.focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).pathname).toBe("/");
  const host = page.getByRole("dialog", { name: "Test host host" });
  await expect(host).toBeVisible();
  const tabs = host.getByRole("navigation");
  await expect(tabs.getByRole("button")).toHaveText(["Usage", "Schedules", "Instructions", "Notifications"]);
  await expect(tabs.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-pressed", "true");
  if (width === 375) {
    const box = (await host.boundingBox())!;
    expect([box.x, box.width, box.height]).toEqual([0, 375, 812]);
  }
  await page.keyboard.press("Escape");
  await expect(host).toBeHidden();
  await expect(trigger).toBeFocused();

  // Schedules are a tab of the host modal.
  await trigger.click();
  const panel = host;
  await tabs.getByRole("button", { name: "Schedules" }).click();
  await expect(panel).toContainText("No schedules on this host yet");
  await panel.getByRole("button", { name: "New schedule" }).click();
  // Validation is inline, and Escape returns to the list without closing the panel.
  await panel.getByRole("button", { name: "Create schedule" }).click();
  await expect(panel.getByLabel("Prompt", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByLabel("Prompt", { exact: true })).toBeFocused();
  await expect(panel).toContainText("Write the prompt to send.");
  await page.keyboard.press("Escape");
  await expect(panel).toContainText("No schedules on this host yet");
  await panel.getByRole("button", { name: "New schedule" }).click();
  await panel.getByLabel("Name").fill("Hourly check");
  await expect(panel.getByLabel("Every")).toHaveValue("1");
  await expect(panel.getByLabel("Unit")).toHaveValue("60");
  await expect(panel).toContainText("Every hour, starting after you create it.");
  await panel.getByRole("radio", { name: "Calendar" }).check();
  await expect(panel.getByLabel("Cron expression")).toHaveValue("0 9 * * 1-5");
  await expect(panel).toContainText(/Weekdays at 09:00 · next /);
  await panel.getByLabel("Cron expression").fill("0 9 *");
  await expect(panel).toContainText("Cron needs 5 fields");
  await panel.getByRole("button", { name: "Daily 09:00" }).click();
  await expect(panel).toContainText("Daily at 09:00");
  await panel.getByRole("radio", { name: "Repeat" }).check();
  await panel.getByLabel("Agent", { exact: true }).selectOption({ label: "Agent 05" });
  await panel.getByLabel("Prompt", { exact: true }).fill("status?");
  await panel.getByRole("button", { name: "Create schedule" }).click();
  const row = panel.getByRole("listitem").filter({ hasText: "Hourly check" });
  await expect(row).toContainText("Every hour → Agent 05");
  await expect(row).toContainText(/Next in \d/);
  await expect(panel.getByRole("button", { name: "New schedule" })).toBeFocused();
  await row.getByRole("button", { name: "Edit Hourly check" }).click();
  const form = panel.getByRole("form", { name: "Edit Hourly check" });
  await expect(form.getByLabel("Prompt", { exact: true })).toHaveValue("status?");
  await form.getByLabel("Unit").selectOption("1");
  await form.getByLabel("Every").fill("90");
  await form.getByLabel("Prompt", { exact: true }).fill("updated status?");
  await form.getByRole("button", { name: "Save schedule" }).click();
  await expect(row).toContainText("Every 90 min");
  await expect(row.getByRole("button", { name: "Edit Hourly check" })).toBeFocused();
  expect(updatedTargets[0]).toMatchObject({ type: "agent", whenBusy: "skip" });
  await row.getByRole("button", { name: "Edit Hourly check" }).click();
  await expect(form.getByLabel("Prompt", { exact: true })).toHaveValue("updated status?");
  await expect(form.getByLabel("If it is busy")).toHaveValue("skip");
  await form.getByRole("button", { name: "Cancel" }).click();
  const toggle = row.getByRole("switch", { name: "Disable Hourly check" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(row.getByRole("switch", { name: "Enable Hourly check" })).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("Paused");
  await expect(panel.getByRole("region", { name: /^Paused/ })).toContainText("Hourly check");
  await row.getByRole("button", { name: "Run Hourly check now" }).click();
  await expect(row).toContainText(/(Sent|Queued) just now/);
  await row.getByRole("button", { name: "Edit Hourly check" }).click();
  await form.getByRole("button", { name: "Delete Hourly check" }).click();
  await form.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(panel).toContainText("No schedules on this host yet");
  await panel.getByRole("button", { name: "New schedule" }).click();
  await panel.getByLabel("Name").fill("New agent check");
  await panel.getByRole("radio", { name: "New agent" }).check();
  await panel.getByLabel("Prompt", { exact: true }).fill("scheduled greeting");
  await panel.getByRole("button", { name: "Create schedule" }).click();
  const fresh = panel.getByRole("listitem").filter({ hasText: "New agent check" });
  await expect(fresh).toContainText("new Claude agent in");
  await fresh.getByRole("button", { name: "Edit New agent check" }).click();
  const freshForm = panel.getByRole("form", { name: "Edit New agent check" });
  await expect(freshForm.getByRole("radio", { name: "New agent" })).toBeChecked();
  await freshForm.getByLabel("Prompt", { exact: true }).fill("updated scheduled greeting");
  await freshForm.getByRole("button", { name: "Save schedule" }).click();
  await expect.poll(() => updatedTargets.length).toBe(2);
  expect(updatedTargets[1]).toMatchObject({ type: "newAgent", config: { model: "fixture-model" } });
  await fresh.getByRole("button", { name: "Run New agent check now" }).click();
  await expect(fresh).toContainText("Started agent");
  await fresh.getByRole("button", { name: "Started agent" }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/a\//);
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await trigger.click();
  await tabs.getByRole("button", { name: "Schedules" }).click();
  await fresh.getByRole("button", { name: "Edit New agent check" }).click();
  await freshForm.getByRole("button", { name: "Delete New agent check" }).click();
  await freshForm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(panel).toContainText("No schedules on this host yet");
  await panel.getByRole("button", { name: "Close host options" }).click();
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  // The launcher's "Schedules" action opens the host modal on its Schedules tab.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("casm:open-schedules", { detail: { host: "" } })));
  await expect(panel).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Schedules" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("button", { name: "New schedule" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

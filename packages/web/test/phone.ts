import { expect, type Page } from "@playwright/test";

// Phones open on the sidebar when nothing is selected and keep it behind the
// Agents button once a chat is open. Desktop always shows it.
export async function openAgents(page: Page) {
  const nav = page.getByRole("navigation", { name: "Agents" });
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  await expect(nav.or(agents).first()).toBeVisible();
  if (!(await nav.isVisible())) await agents.click();
  await expect(nav).toBeVisible();
}

import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

test("move a project to the top or middle and keep the order after reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const projectLists = new Set<number>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "project.list") projectLists.add(request.id);
      server.send(raw);
    });
    server.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (projectLists.delete(message.id) && message.result?.projects.length) {
        const [project] = message.result.projects;
        message.result.projects.push(
          { ...project, id: "project-alpha", name: "Alpha project", sort: -1 },
          { ...project, id: "project-zulu", name: "Zulu project", sort: 1 },
        );
      }
      socket.send(JSON.stringify(message));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(testHome + "/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const projects = page.locator("aside .project-name");
  await expect(projects).toHaveText(["Alpha project", "Design review", "Test project", "Zulu project"]);
  const reorder = page.getByRole("button", { name: "Reorder folders on Test host" });
  await expect(reorder).toBeInViewport();
  await reorder.click();
  const dialog = page.getByRole("dialog", { name: "Reorder folders" });
  await dialog.getByRole("combobox", { name: "Position of Zulu project" }).selectOption("0");
  await expect(dialog.getByRole("status")).toHaveText("Zulu project moved to position 1.");
  await dialog.getByRole("combobox", { name: "Position of Test project" }).selectOption("1");
  await dialog.getByRole("button", { name: "Close folder order" }).click();
  await expect(projects).toHaveText(["Zulu project", "Test project", "Alpha project", "Design review"]);
  await page.reload();
  await expect(projects).toHaveText(["Zulu project", "Test project", "Alpha project", "Design review"]);
});

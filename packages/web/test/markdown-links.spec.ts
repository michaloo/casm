import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

test("markdown external links open a new tab while app links stay internal", async ({ page, context }) => {
  const url = "https://developers.google.com/tag-platform/tag-manager/server-side/dependency-serving?option=sgtm";
  await context.route("https://developers.google.com/**", route => route.fulfill({ contentType: "text/html", body: "External guidance" }));
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const histories = new Set<number>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.method === "agent.history") histories.add(request.id);
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (histories.delete(response.id)) response.result = { start: 0, items: [{ kind: "assistant", id: "links", text: `[Google's first-party script guidance](${url})\n\n[App home](/) · [Mail](mailto:hello@example.com) · [Same origin](${page.url()})` }] };
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /Agent 00/ }).click();
  const link = page.getByRole("link", { name: "Google's first-party script guidance" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Mail", exact: true })).toHaveAttribute("target", "_blank");
  for (const name of ["App home", "Same origin"]) await expect(page.getByRole("link", { name, exact: true })).not.toHaveAttribute("target");
  const original = page.url();
  const opened = page.waitForEvent("popup");
  await link.click();
  const popup = await opened;
  await expect(popup).toHaveURL(url);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toBe(original);
  await popup.close();
});

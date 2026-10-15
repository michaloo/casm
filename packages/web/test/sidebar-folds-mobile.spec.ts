import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";

// Hosts are section headers; projects are lighter rows whose whole width folds.
for (const width of [1440, 375]) test(`project rows fold and hosts read as headers at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 812 });
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request.method === "peer.list") socket.send(JSON.stringify({ id: request.id, result: { peers: [{ name: "Peer host", serverId: "peer" }] } }));
      else server.send(raw);
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Agents" });
  const project = nav.getByRole("button", { name: "Toggle Test project", exact: true });
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("button", { name: /Agent 00/ })).toBeVisible();

  // No + on project rows: a row is its fold toggle and its ⋯ only.
  for (const row of await nav.locator(".project-row").all()) {
    await expect(row.getByRole("button")).toHaveCount(2);
    await expect(row).not.toContainText("＋");
    await expect(row.locator(".plus-glyph")).toHaveCount(0);
  }
  // The name folds too, not just the chevron.
  await project.locator(".project-name").click();
  await expect(project).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("button", { name: /Agent 00/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(project.locator(".project-count")).toHaveText(/^\d+$/);
  await project.click();
  await expect(project).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("button", { name: /Agent 00/ })).toBeVisible();
  const toggleBox = (await project.boundingBox())!;
  const optionsBox = (await nav.getByRole("button", { name: "Project options for Test project", exact: true }).boundingBox())!;
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(optionsBox.x + 1);
  expect(toggleBox.width).toBeGreaterThan(150);

  // Hosts: a tinted full-width header, small caps, server glyph and status dot,
  // projects indented and lighter. Both put the chevron at the far right, after + and ⋯.
  const host = nav.getByRole("button", { name: "Toggle Test host host", exact: true });
  await expect(host.locator(".server-glyph")).toHaveCount(1);
  await expect(host.locator(".host-dot.online")).toHaveCount(1);
  const styles = await page.evaluate(() => {
    const host = document.querySelector("nav .host-heading")!;
    const hostName = host.querySelector(".host-name")!;
    const projectName = document.querySelector("nav .project-name")!;
    const hostChevron = host.querySelector(".chevron-glyph")!;
    const projectChevron = document.querySelector("nav .project-toggle .chevron-glyph")!;
    const box = (el: Element) => el.getBoundingClientRect().toJSON();
    return {
      hostTransform: getComputedStyle(hostName).textTransform, hostWeight: Number(getComputedStyle(hostName).fontWeight),
      projectTransform: getComputedStyle(projectName).textTransform, projectWeight: Number(getComputedStyle(projectName).fontWeight),
      hostBackground: getComputedStyle(host).backgroundColor, projectBackground: getComputedStyle(document.querySelector("nav .project-row")!).backgroundColor,
      hostChevronColor: getComputedStyle(hostChevron).color, projectChevronColor: getComputedStyle(projectChevron).color,
      hostStroke: getComputedStyle(hostChevron).strokeWidth, projectStroke: getComputedStyle(projectChevron).strokeWidth,
      hostBox: box(host), hostChevron: box(hostChevron), hostNameBox: box(hostName), projectChevron: box(projectChevron),
      projectRow: box(document.querySelector("nav .project-row")!),
      hostMore: box(host.querySelector(".row-more:last-of-type")!), projectMore: box(document.querySelector("nav .project-row .row-more")!),
      hostRotate: getComputedStyle(hostChevron).rotate,
    };
  });
  expect(styles.hostTransform).toBe("uppercase");
  expect(styles.projectTransform).toBe("none");
  expect(styles.hostWeight).toBeGreaterThan(styles.projectWeight);
  expect(styles.hostBackground).not.toBe(styles.projectBackground);
  expect(styles.hostChevronColor).not.toBe(styles.projectChevronColor);
  expect(parseFloat(styles.projectStroke)).toBeLessThan(parseFloat(styles.hostStroke));
  // icon · name · + · ⋯ · chevron, on hosts and projects alike; ⌃ while open.
  expect(styles.hostChevron.x).toBeGreaterThan(styles.hostMore.x + styles.hostMore.width);
  expect(styles.projectChevron.x).toBeGreaterThan(styles.projectMore.x + styles.projectMore.width);
  expect(styles.hostBox.x + styles.hostBox.width - (styles.hostChevron.x + styles.hostChevron.width)).toBeLessThan(width === 375 ? 20 : 12);
  expect(Math.abs(styles.hostChevron.x - styles.projectChevron.x)).toBeLessThan(2);
  expect(styles.hostRotate).toBe("180deg");
  expect(styles.projectRow.x).toBeGreaterThan(styles.hostBox.x);
  expect(Math.round(styles.hostBox.width)).toBeGreaterThan(200);
  // Both chevrons are centered on their rows.
  for (const [mark, row] of [[styles.hostChevron, styles.hostBox], [styles.projectChevron, styles.projectRow]])
    expect(Math.abs(mark.y + mark.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(1.5);
  // Clear space between host sections.
  const peer = nav.locator("section.host").nth(1).locator(".host-heading");
  await host.click();
  await expect(host).toHaveAttribute("aria-expanded", "false");
  // ⌄ while folded; the turn finishes quickly.
  await expect.poll(() => host.locator(".chevron-glyph").evaluate((el) => getComputedStyle(el).rotate)).toBe("none");
  const [first, second] = [(await nav.locator("section.host").first().locator(".host-heading").boundingBox())!, (await peer.boundingBox())!];
  expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(16);
  await host.click();

  // The host row: the name in full, no status text or clock.
  await expect(nav.getByRole("button", { name: "New project on Test host", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: /^Schedules on / })).toHaveCount(0);
  await expect(host.locator("small")).toHaveCount(0);
  const name = host.locator(".host-name");
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Focus rings follow the keyboard: none after a click (also when focus returns from a modal), shown on Tab.
  const outline = (el: import("@playwright/test").Locator) => el.evaluate((e) => getComputedStyle(e).outlineStyle);
  await host.click();
  await host.click();
  expect(await outline(host)).toBe("none");
  const options = nav.getByRole("button", { name: "Host options for Test host", exact: true });
  await options.click();
  await page.getByRole("button", { name: "Close host options" }).click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(options).toBeFocused();
  expect(await outline(options)).toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Test host host" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
  expect(await outline(options)).toBe("solid");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await nav.getByRole("button", { name: "Test project", exact: false }).first().hover();
    await page.screenshot({ path: test.info().outputPath(`sidebar-${scheme}-${width}.png`), clip: { x: 0, y: 0, width: Math.min(width, 380), height: 520 } });
  }
});

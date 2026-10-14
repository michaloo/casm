import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { testHome } from "./config.ts";

for (const width of [1440, 375]) test(`new project mobile suggestions create and missing-folder error at ${width}`, async ({ page }, info) => {
  const root = `${testHome}/new-project-${width}-${info.project.name}`;
  mkdirSync(`${root}/sample-folder`, { recursive: true });
  mkdirSync(`${root}/second-folder`, { recursive: true });
  writeFileSync(`${root}/sample-folder/README.md`, "Project fixture");
  writeFileSync(`${root}/second-folder/README.md`, "Another fixture");
  writeFileSync(`${root}/sample-file.txt`, "Not a directory");
  const peer = width === 375;
  const hostName = peer ? "Project peer" : "Test host";
  const calls: { method: string; host?: string; params: Record<string, any> }[] = [];
  const projects: Record<string, any>[] = [];
  let disconnect: (() => void) | undefined;
  let offline = false;
  await page.routeWebSocket("**", socket => {
    if (offline) { socket.close(); return; }
    const server = socket.connectToServer();
    const methods = new Map<number, string>();
    disconnect = () => { offline = true; socket.close(); };
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      methods.set(request.id, request.method);
      if (["fs.search", "project.create"].includes(request.method)) calls.push(structuredClone(request));
      if (peer && request.method === "peer.list") {
        socket.send(JSON.stringify({ id: request.id, result: { peers: [{ name: hostName, serverId: "new-project-peer" }] } })); return;
      }
      if (request.host === hostName) delete request.host;
      server.send(JSON.stringify(request));
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (methods.get(response.id) === "project.list") for (const project of response.result.projects) project.group = "Existing group";
      if (methods.get(response.id) === "project.create" && response.result) projects.push(response.result);
      socket.send(JSON.stringify(response));
    });
  });
  await page.setViewportSize({ width, height: 812 });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (width === 375) {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Test host host", exact: true }).click();
  }
  await page.getByRole("button", { name: `New project on ${hostName}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `New project on ${hostName}`, exact: true });
  const folder = dialog.getByRole("combobox", { name: "Folder", exact: true });
  const create = dialog.getByRole("button", { name: "Create project", exact: true });
  await expect(folder).toBeFocused();
  await folder.fill("relative/folder");
  await expect(create).toBeDisabled();
  await folder.fill(`${root}/sam`);
  const suggestions = dialog.getByRole("listbox", { name: "Folder suggestions" });
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(suggestions).toContainText(`${root}/sample-folder`);
  await expect(suggestions).not.toContainText("sample-file.txt");
  await folder.press("ArrowDown"); await folder.press("ArrowUp"); await folder.press("Enter");
  await expect(folder).toHaveValue(`${root}/sample-folder`);
  await expect(suggestions).toBeHidden();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute("placeholder", "sample-folder");
  await expect(dialog).toContainText(`A folder on ${hostName}. It can't be changed later.`);
  await folder.fill(`${root}/does-not-exist`);
  await create.click();
  await expect(dialog.getByRole("alert")).toContainText("no such directory");
  await expect(create).toBeEnabled();
  await folder.fill(`${root}/sam`);
  await suggestions.getByRole("option").click();
  await dialog.getByRole("combobox", { name: "Existing groups" }).selectOption("Existing group");
  await dialog.getByRole("textbox", { name: "Tags", exact: true }).fill(" web, mobile, ");
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  if (width === 375) { expect((await dialog.boundingBox())!.width).toBe(375); expect((await dialog.boundingBox())!.height).toBe(812); }
  await page.screenshot({ path: info.outputPath(`new-project-${width}.png`) });
  await create.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".chat > header strong")).toHaveText("sample-folder");
  await expect(page.locator(".chat > header")).toContainText("New agent");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  expect(projects.at(-1)?.path).toBe(`${root}/sample-folder`);
  expect(projects.at(-1)?.group).toBe("Existing group");
  expect(projects.at(-1)?.tags).toEqual(["web", "mobile"]);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain(`/h/${hostName}/p/`);
  expect(calls.filter(call => call.method === "fs.search").some(call => call.params.cwd === root && call.params.query === "sam")).toBe(true);
  for (const call of calls) expect(call.host ?? "").toBe(peer ? hostName : "");
  await page.reload();
  await expect(page.locator(".chat > header strong")).toHaveText("sample-folder");
  if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: `New project on ${hostName}`, exact: true }).click();
  await folder.fill(`${root}/second-folder`);
  disconnect!();
  await expect(create).toBeDisabled();
  await expect(dialog).toContainText("Host offline");
});

import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures.ts";
import { testHome } from "./config.ts";

const providers = ["claude", "codex", "opencode", "pi"];
const names = ["Claude", "Codex", "OpenCode", "pi"];
const models = ["Opus 5.5", "GPT-6-Astra", "Local model", "Sonnet"];
for (const width of [1440, 375]) test(`composer picker mobile snapshots and choices at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 812 });
  const updates: Record<string, string>[] = [];
  await page.routeWebSocket("**", socket => {
    const server = socket.connectToServer();
    const requests = new Map<number, string>();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      requests.set(request.id, request.method);
      if (request.method === "provider.catalog") {
        const index = providers.indexOf(request.params.provider);
        socket.send(JSON.stringify({ id: request.id, result: {
          models: [{ id: "default", name: "Default (recommended)", isDefault: true }, { id: "effective", name: `${models[index]} · 1M`, description: "A capable model with 1M context", efforts: index === 3 ? ["high"] : ["low", "high"] }, { id: "long", name: "A very long model display name that should truncate gracefully in the composer", description: "Long model description" }],
          modes: index === 3 ? [{ id: "default", name: "Default" }] : [{ id: "auto", name: "Automatic permission handling", description: "Review tool permissions automatically" }, { id: "plan", name: "Plan mode", description: "Explore before editing files" }, { id: "acceptEdits", name: "Accept file edits" }],
        } })); return;
      }
      if (request.method === "agent.update") {
        updates.push(request.params.config);
        socket.send(JSON.stringify({ id: request.id, result: {} })); return;
      }
      if (request.method === "agent.send") {
        socket.send(JSON.stringify({ id: request.id, result: { queued: false } })); return;
      }
      server.send(raw);
    });
    server.onMessage(raw => {
      const response = JSON.parse(String(raw));
      if (requests.get(response.id) === "agent.list") {
        for (let index = 0; index < 4; index++) {
          const agent = response.result.agents.find((item: { name: string }) => item.name === `Agent 0${index}`);
          agent.provider = providers[index]; agent.config = { mode: "auto", effort: "high" }; agent.effectiveModel = "effective";
        }
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const sidebar = async () => { if (width === 375) await page.getByRole("button", { name: "Agents", exact: true }).click(); };
  const pickers = page.locator(".pickers");
  const face = (name: string) => pickers.locator(".composer-picker").filter({ has: page.getByRole("combobox", { name, exact: true }) }).locator(".composer-picker-label");
  async function snapshot(name: string) {
    await page.evaluate(() => document.fonts.ready);
    for (const pill of await pickers.locator(".composer-picker").all()) {
      const box = (await pill.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBe(width === 375 ? 44 : 32);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.locator(".composer").screenshot({ path: info.outputPath(`${name}-${width}.png`) });
  }
  for (let index = 0; index < 4; index++) {
    await sidebar();
    await page.getByRole("button", { name: new RegExp(`Agent 0${index}`) }).click();
    await expect(face("Model")).toHaveText(`Default · ${models[index]}`);
    await expect(pickers.locator(".composer-picker-fixed")).toHaveText(names[index]);
    await expect(pickers.locator(".composer-picker-fixed .provider-icon")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Mode", exact: true })).toHaveCount(index === 3 ? 0 : 1);
    await expect(page.getByRole("combobox", { name: "Effort", exact: true })).toHaveCount(index === 3 ? 0 : 1);
    await snapshot(`agent-${providers[index]}`);
    if (index === 0) {
      await page.getByRole("combobox", { name: "Mode", exact: true }).selectOption("plan");
      await expect(face("Mode")).toHaveText("Plan");
      await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("low");
      await page.getByLabel("Message", { exact: true }).fill("Apply picker choices");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => updates.at(-1)?.effort).toBe("low");
      expect(updates.at(-1)?.mode).toBe("plan");
    }
  }
  await sidebar();
  await page.getByRole("button", { name: "Test project ＋", exact: true }).click();
  for (let index = 0; index < 4; index++) {
    await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption(providers[index]);
    await expect(face("Provider")).toHaveText(names[index]);
    await expect(face("Model")).toHaveText("Default");
    await snapshot(`draft-${providers[index]}-default`);
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("effective");
    await expect(face("Model")).toHaveText(models[index]);
    await expect(page.getByRole("combobox", { name: "Model", exact: true }).locator('option[value="effective"]')).toContainText("1M context");
    await snapshot(`draft-${providers[index]}`);
  }
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("long");
  expect(await face("Model").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await snapshot("draft-long-model");
});

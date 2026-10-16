import { testHome } from "./config.ts";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import type { QuestionRequest } from "@casm/protocol";
import { openAgents } from "./phone.ts";

async function question(page: Page, prompts: QuestionRequest["prompts"]) {
  const submissions: Record<string, unknown>[] = [];
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer();
    const subscriptions = new Set<string | number>();
    socket.onMessage((message) => {
      const request = JSON.parse(String(message));
      if (request.method === "agent.subscribe") subscriptions.add(request.id);
      if (request.method === "agent.answerQuestion") {
        submissions.push(request.params);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
      } else server.send(message);
    });
    server.onMessage((message) => {
      const response = JSON.parse(String(message));
      if (subscriptions.delete(response.id) && response.result) {
        response.result.questions = [{ id: "question-shape", title: "Answer shape", prompts }];
      }
      socket.send(JSON.stringify(response));
    });
  });
  await page.goto("/");
  await page.getByLabel("Server token").fill(readFileSync(`${testHome}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await openAgents(page);
  await page.getByRole("button", { name: /Agent 00/ }).click();
  await expect(page.getByText("Answer shape", { exact: true })).toBeVisible();
  return submissions;
}

const multiple = {
  id: "colors", text: "Choose colors", kind: "select" as const, multiple: true, allowOther: true,
  options: [{ label: "Blue", description: "Ocean" }, { label: "Green" }, { label: "Red" }],
};

test("multiple selections and custom answers remain separate array entries on the wire", async ({ page }) => {
  const submissions = await question(page, [multiple]);
  const options = page.getByRole("group", { name: "Choose colors" });
  const other = page.getByLabel("Other answers (one per line)");
  await options.getByRole("checkbox", { name: /Blue/ }).check();
  await options.getByRole("checkbox", { name: "Green" }).check();
  await other.fill(" Violet, lavender \n\n Amber ");
  await expect(options.getByRole("checkbox", { name: /Blue/ })).toBeChecked();
  await options.getByRole("checkbox", { name: "Green" }).uncheck();
  await options.getByRole("checkbox", { name: "Red" }).check();
  await expect(other).toHaveValue(" Violet, lavender \n\n Amber ");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.poll(() => submissions).toEqual([expect.objectContaining({
    requestId: "question-shape", answers: { colors: ["Blue", "Red", "Violet, lavender", "Amber"] },
  })]);
});

test("multiple allows only options or only custom answers but requires an answer", async ({ page }) => {
  const submissions = await question(page, [multiple]);
  const options = page.getByRole("group", { name: "Choose colors" });
  const other = page.getByLabel("Other answers (one per line)");
  const submit = page.getByRole("button", { name: "Answer", exact: true });
  await other.fill("  \n ");
  await submit.click();
  expect(await options.getByRole("checkbox").first().evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  expect(submissions).toHaveLength(0);
  await other.fill("Custom only");
  await submit.click();
  await expect.poll(() => submissions[0]?.answers).toEqual({ colors: ["Custom only"] });
  await options.getByRole("checkbox", { name: "Green" }).check();
  await other.fill("");
  await submit.click();
  await expect.poll(() => submissions[1]?.answers).toEqual({ colors: ["Green"] });
});

test("confirm, single, text, closed multiple and dismissal keep their wire shapes", async ({ page }) => {
  const submissions = await question(page, [
    { id: "confirm", text: "Continue?", kind: "confirm" },
    { id: "single", text: "One color", kind: "select", options: [{ label: "Blue" }] },
    { id: "custom", text: "Custom color", kind: "select", allowOther: true, options: [{ label: "Blue" }] },
    { id: "text", text: "Notes", kind: "text" },
    { id: "secret", text: "Secret", kind: "text", secret: true },
    { ...multiple, id: "closed", text: "Closed colors", allowOther: false },
  ]);
  await page.getByLabel("Continue?").selectOption("false");
  await page.getByLabel("One color").selectOption("Blue");
  await page.getByLabel("Custom color").fill("Purple");
  await page.getByLabel("Notes").fill("Keep this text");
  await expect(page.getByLabel("Secret", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("Secret", { exact: true }).fill("hidden");
  await page.getByRole("group", { name: "Closed colors" }).getByRole("checkbox", { name: /Blue/ }).check();
  await page.getByRole("group", { name: "Closed colors" }).getByRole("checkbox", { name: "Green" }).check();
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.poll(() => submissions[0]?.answers).toEqual({
    confirm: false, single: "Blue", custom: "Purple", text: "Keep this text", secret: "hidden", closed: ["Blue", "Green"],
  });
  await page.getByLabel("Continue?").selectOption("true");
  await page.getByLabel("Custom color").fill("Blue");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.poll(() => submissions[1]?.answers).toMatchObject({ confirm: true, custom: "Blue" });
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2]).toEqual({ id: expect.any(String), requestId: "question-shape" });
});

test("multiline text answers preserve newlines while secret answers stay masked", async ({ page }) => {
  const submissions = await question(page, [
    { id: "notes", text: "Long notes", kind: "text", multiline: true },
    { id: "secret", text: "Private value", kind: "text", multiline: true, secret: true },
  ]);
  const notes = page.getByLabel("Long notes");
  await expect(notes).toHaveJSProperty("tagName", "TEXTAREA");
  await notes.fill("First line\n\nLast line");
  await expect(page.getByLabel("Private value")).toHaveAttribute("type", "password");
  await page.getByLabel("Private value").fill("hidden");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.poll(() => submissions[0]?.answers).toEqual({ notes: "First line\n\nLast line", secret: "hidden" });
});

test("mobile choice descriptions wrap and actions have touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await question(page, [{ ...multiple, options: [{ label: "Detailed choice", description: "A readable description with enough context to distinguish this choice from other options on a narrow phone screen." }] }]);
  const description = page.locator(".option-description");
  expect(await description.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect((await description.boundingBox())!.height).toBeGreaterThan(30);
  for (const control of await page.locator(".question-option, .card button").all())
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

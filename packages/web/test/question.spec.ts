import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import type { QuestionRequest } from "@casm/protocol";

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
  await page.getByLabel("Server token").fill(readFileSync("/tmp/casm-web-dev/web-token", "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
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
  const options = page.getByRole("listbox", { name: "Options", exact: true });
  const other = page.getByLabel("Other answers (one per line)");
  await options.selectOption(["Blue", "Green"]);
  await other.fill(" Violet, lavender \n\n Amber ");
  await expect(options).toHaveValues(["Blue", "Green"]);
  await options.selectOption(["Blue", "Red"]);
  await expect(other).toHaveValue(" Violet, lavender \n\n Amber ");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.poll(() => submissions).toEqual([expect.objectContaining({
    requestId: "question-shape", answers: { colors: ["Blue", "Red", "Violet, lavender", "Amber"] },
  })]);
});

test("multiple allows only options or only custom answers but requires an answer", async ({ page }) => {
  const submissions = await question(page, [multiple]);
  const options = page.getByRole("listbox", { name: "Options", exact: true });
  const other = page.getByLabel("Other answers (one per line)");
  const submit = page.getByRole("button", { name: "Answer", exact: true });
  await other.fill("  \n ");
  await submit.click();
  expect(await options.evaluate((element: HTMLSelectElement) => element.validity.valueMissing)).toBe(true);
  expect(submissions).toHaveLength(0);
  await other.fill("Custom only");
  await submit.click();
  await expect.poll(() => submissions[0]?.answers).toEqual({ colors: ["Custom only"] });
  await options.selectOption(["Green"]);
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
  await page.getByLabel("Closed colors").selectOption(["Blue", "Green"]);
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

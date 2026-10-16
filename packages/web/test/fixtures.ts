// Every test gets its own freshly seeded server (it boots in about 0.3s), so no
// test can see the agents, queues or history another test or repeat left behind.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test as base, expect } from "@playwright/test";
import { testHome, testPort, testURL } from "./config.ts";

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(killer);
}

export const test = base.extend<{ server: void; scenario: string }>({
  baseURL: async ({}, use) => use(testURL),
  // "memory": the heavy workspace of memory-fixture.ts besides the usual one.
  scenario: ["", { option: true }],
  server: [
    async ({ scenario }, use) => {
      const env = { ...process.env, CASM_WEB_TEST_PORT: String(testPort), CASM_WEB_TEST_HOME: testHome, CASM_WEB_TEST_SCENARIO: scenario };
      // The child applies the worker offset itself only if it sees an index.
      delete env.TEST_PARALLEL_INDEX;
      env.CASM_WEB_TEST_PORT = String(testPort);
      env.CASM_WEB_TEST_HOME = testHome;
      const child = spawn("node", [resolve(import.meta.dirname, "server.ts")], {
        cwd: resolve(import.meta.dirname, "../../.."),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      const failed = new Promise<never>((_, reject) =>
        child.once("exit", (code) => reject(new Error(`test server exited with ${code}\n${log}`))),
      );
      failed.catch(() => {});
      const ready = (async () => {
        for (let i = 0; i < 400; i++) {
          try {
            if ((await fetch(`${testURL}/health`)).ok) return;
          } catch {}
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`test server did not become healthy\n${log}`);
      })();
      await Promise.race([ready, failed]);
      await use();
      await stop(child);
    },
    { auto: true },
  ],
});
export { expect };

/** Opens a project's new-agent screen the way people do: its ⋯ modal's New agent. */
export async function openNewAgent(page: import("@playwright/test").Page, project = "Test project") {
  await page.getByRole("button", { name: `Project options for ${project}`, exact: true }).click();
  await page.getByRole("dialog", { name: `${project} project` }).getByRole("button", { name: "New agent", exact: true }).click();
}

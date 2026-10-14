import { defineConfig } from "@playwright/test";
import { testURL } from "./test/config.ts";
export default defineConfig({
  testDir: "test",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: testURL,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command:
      "node packages/web/test/server.ts",
    cwd: "../..",
    url: `${testURL}/health`,
    reuseExistingServer: false,
  },
  reporter: "list",
});

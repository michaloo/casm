import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:7495",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command:
      "CASM_DEV_HOME=/tmp/casm-web-dev CASM_DEV_PORT=7495 node packages/web/test/server.ts",
    cwd: "../..",
    url: "http://127.0.0.1:7495/health",
    reuseExistingServer: false,
  },
  reporter: "list",
});

import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "test",
  testMatch: "*.spec.ts",
  workers: 1,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit-iphone-13-mini",
      grep: /phone layout|mobile|375|question\.spec\.ts|pending-mobile\.spec\.ts/,
      use: {
        ...devices["iPhone 13 Mini"],
        browserName: "webkit",
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  reporter: "list",
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 0,
      threshold: 0
    }
  },
  use: {
    baseURL: "http://127.0.0.1:4180",
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    deviceScaleFactor: 1
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "pnpm dev --port 4180",
    env: {
      VITE_ADMIN_DEMO_MODE: "true"
    },
    url: "http://127.0.0.1:4180",
    reuseExistingServer: !process.env.CI
  }
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:4181",
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: "pnpm dev --port 4181",
    url: "http://127.0.0.1:4181",
    reuseExistingServer: !process.env.CI
  }
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: "http://127.0.0.1:4180",
    trace: "on-first-retry"
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

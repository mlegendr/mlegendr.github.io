import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    // Escape hatch for environments that ship their own Chromium (CI images,
    // sandboxes) instead of the build `npx playwright install` would fetch.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // A dedicated database so an e2e run can never touch the user's pool.
        command: "npm run db:setup && npm run db:seed && npx next dev -p 3100",
        url: "http://127.0.0.1:3100/api/health",
        reuseExistingServer: false,
        timeout: 300_000,
        env: {
          DATABASE_URL: "file:./e2e.db",
          NFL_SEASON: "2026",
          // Sentinel values: one test asserts these never appear in any page or
          // API response. They are deliberately invalid, so the odds provider
          // fails and the app must fall back gracefully.
          ODDS_API_KEY: "e2e-sentinel-odds-key",
          SPORTSDATAIO_API_KEY: "e2e-sentinel-sportsdataio-key",
        },
      },
});

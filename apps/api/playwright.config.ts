import { defineConfig } from "@playwright/test";

/**
 * The browser tier runs the built SPA against the in-process API fixture. The
 * fixture owns its ports, so Playwright only owns the browser lifecycle and
 * its failure artifacts.
 */
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results/playwright",
  reporter: [["list"], ["html", { outputFolder: "test-results/playwright-report", open: "never" }]],
  use: {
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

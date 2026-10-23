import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "extension.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { actionTimeout: 30_000 },
  timeout: 300_000,
  expect: { timeout: 120_000 },
  outputDir: "../test-results",
  reporter: [["list"], ["html", { outputFolder: "../playwright-report", open: "never" }]],
  projects: (process.env.E2E_LANE === "extended" ? ["dark-wide", "light-narrow"] : ["dark-wide"]).map((name) => ({
    name,
  })),
});

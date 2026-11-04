import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  timeout: 20_000,
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "tests/performance/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});

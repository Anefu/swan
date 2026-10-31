import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts", "bench/src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20_000,
  },
});

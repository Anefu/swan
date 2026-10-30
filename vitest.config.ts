import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts"],
    environment: "node",
    // The server reads PH_HOME at import time; tests never touch the user's real one.
    env: { PH_HOME: path.join(os.tmpdir(), `ph-test-${process.pid}`) },
    testTimeout: 20_000,
  },
});

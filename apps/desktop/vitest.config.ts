import { defineConfig } from "vitest/config";

// The repository's setup gives every test a temporary PH_HOME, also when Vitest runs from this folder.
export default defineConfig({
  test: { environment: "node", setupFiles: ["../../vitest.setup.ts"], testTimeout: 20_000 },
});

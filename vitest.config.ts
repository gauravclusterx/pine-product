import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    // One real PostgreSQL is shared by the run; files run one at a time so tests never see
    // each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

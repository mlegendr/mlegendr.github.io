import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // The persistence/engine suites share one throwaway SQLite file, so test
    // files must not run concurrently against it.
    fileParallelism: false,
    env: { DATABASE_URL: "file:./test.db", OFFLINE_MODE: "1", NFL_SEASON: "2026" },
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});

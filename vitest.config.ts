import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    environment: "node",
    testTimeout: 10_000,
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});

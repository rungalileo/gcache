import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Package coverage measures shipped code. Formal tooling has its own
      // model checks, replay gates, and positive/negative harness controls.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "test/**"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});

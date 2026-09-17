import { defineConfig } from "vitest/config";

// This package's source is the shared ESLint config itself: plain JS at the
// package root, exercised by test/boundaries.test.mjs and test/workspace.test.mjs.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["base.js", "module-boundaries.js"],
      exclude: [],
    },
  },
});

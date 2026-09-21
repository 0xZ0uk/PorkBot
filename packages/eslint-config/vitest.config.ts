import { defineConfig } from "vitest/config";

// This package's source is the shared ESLint config itself: plain JS at the
// package root, exercised by test/boundaries.test.mjs and test/workspace.test.mjs.
//
// It does not call the shared tier presets: the module map makes internal config
// packages leaves (`imports: []`), and `@porkbot/testkit` imports this package,
// so an edge back would be a dev-only cycle between the two. The numbers below
// are therefore repeated here on purpose, and the guard test in
// packages/testkit/test/tier-policy.test.ts fails if they drift from the unit
// tier's policy.
export default defineConfig({
  test: {
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    retry: 0,
    allowOnly: false,
    // The fixtures are inputs to the linter, never tests.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.e2e.test.ts",
      "**/test/e2e/**",
      "**/fixtures/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["base.js", "module-boundaries.js", "ui-colors.js", "ui-register.js"],
      exclude: [],
    },
  },
});

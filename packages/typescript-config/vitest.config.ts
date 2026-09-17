import { defineConfig } from "vitest/config";

// The strictness tests read the JSON bases in this package; there is no source
// to instrument.
//
// Like @porkbot/eslint-config, this package is a leaf in the module map, so it
// cannot import the shared tier presets from @porkbot/testkit. The guard test in
// packages/testkit/test/tier-policy.test.ts fails if these numbers drift from
// the unit tier's policy.
export default defineConfig({
  test: {
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    retry: 0,
    allowOnly: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "**/*.e2e.test.ts",
      "**/test/e2e/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [],
      exclude: [],
    },
  },
});

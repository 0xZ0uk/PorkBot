// A deliberate AGENTS.md violation: a UI surface hardcoding its colours instead
// of importing the semantic tokens. packages/eslint-config/test/ui-colors.test.mjs
// lints this file and fails when the rule stops firing.
export const card = {
  background: "#16161d",
  borderColor: "rgb(42, 42, 53)",
  shadowColor: "oklch(0.6231 0.1880 259.8145)",
};

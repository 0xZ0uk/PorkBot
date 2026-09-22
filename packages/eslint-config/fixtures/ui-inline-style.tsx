// A deliberate AGENTS.md (UI) violation: styling through an inline style
// object instead of a class. packages/eslint-config/test/ui-design-system.test.mjs
// lints this file and fails when the rule stops firing.
export function Panel() {
  return <div style={{ color: "red" }}>Body</div>;
}

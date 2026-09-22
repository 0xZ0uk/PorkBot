// A deliberate AGENTS.md (UI) violation: a class no build generates, so the
// element ships unstyled. packages/eslint-config/test/ui-design-system.test.mjs
// lints this file and fails when the rule stops firing.
export function Panel() {
  return <div className="flex-cols rounded-huge">Body</div>;
}

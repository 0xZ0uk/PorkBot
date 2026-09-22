// A deliberate AGENTS.md (UI) violation: an off-token value hardcoded into a
// class. packages/eslint-config/test/ui-design-system.test.mjs lints this file
// and fails when the rule stops firing.
export function Panel() {
  return <div className="p-[13px]">Body</div>;
}

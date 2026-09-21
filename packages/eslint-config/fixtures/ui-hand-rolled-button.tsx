// A deliberate AGENTS.md violation: a surface drawing its own button instead
// of importing Button from @porkbot/ui. packages/eslint-config/test/ui-register.test.mjs
// lints this file and fails when the rule stops firing.
export function Save() {
  return (
    <button className="save" type="button">
      Save
    </button>
  );
}

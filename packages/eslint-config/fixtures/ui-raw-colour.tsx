// A deliberate AGENTS.md (UI) violation: a raw palette colour where the theme's
// semantic tokens belong. packages/eslint-config/test/ui-design-system.test.mjs
// lints this file and fails when the rule stops firing.
export function Banner() {
  return <div className="bg-pink-500 text-zinc-100">Heads up</div>;
}

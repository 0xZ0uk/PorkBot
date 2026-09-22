import { Button } from "@porkbot/ui";

// A deliberate AGENTS.md (UI) violation: a class name the linter cannot read,
// so no other rule can check what it changes.
// packages/eslint-config/test/ui-design-system.test.mjs lints this file and
// fails when the rule stops firing.
export function Save({ tone }: { tone: string }) {
  return <Button className={`bg-${tone}`}>Save</Button>;
}

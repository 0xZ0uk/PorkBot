import { Button, Card } from "@porkbot/ui";

// A deliberate AGENTS.md (UI) violation: a surface restyling a register
// component instead of reaching for its variants. packages/eslint-config/
// test/ui-design-system.test.mjs lints this file and fails when the rule
// stops firing.
export function Notice() {
  return (
    <Card className="p-4 bg-pink-500 rounded-full">
      <Button className="text-sm">Save</Button>
    </Card>
  );
}

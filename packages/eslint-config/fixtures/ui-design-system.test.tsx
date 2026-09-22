import { Button } from "@porkbot/ui";

// The rules stay silent in test files: a suite asserts on markup and state and
// must be free to render a component in a shape a screen would not ship.
// packages/eslint-config/test/ui-design-system.test.mjs lints this file and
// fails when a rule fires here.
export function RestyledFixture() {
  return (
    <Button className="p-4 bg-pink-500" style={{ color: "red" }}>
      Save
    </Button>
  );
}

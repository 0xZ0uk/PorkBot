import { Button, Card, Field, Input } from "@porkbot/ui";

// The legal version of the design-system fixtures: the same screen composed
// from the register, placed by layout and styled by variant. This fixture
// catches a rule that fires on the composition it is supposed to encourage.
export function BotEditor() {
  return (
    <Card className="mt-4 w-full">
      <Field label="Name" htmlFor="bot-name">
        <Input id="bot-name" name="name" />
      </Field>
      <Button type="submit" variant="primary">
        Save
      </Button>
    </Card>
  );
}

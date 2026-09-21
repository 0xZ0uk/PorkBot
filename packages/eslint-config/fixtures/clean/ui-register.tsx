import { Button, Card, Field, Input } from "@porkbot/ui";

// The legal version of the register fixtures: the same screen composed from
// the register. This fixture catches a rule that fires on the imports it is
// supposed to encourage.
export function BotEditor() {
  return (
    <Card>
      <Field label="Name" htmlFor="bot-name">
        <Input id="bot-name" name="name" />
      </Field>
      <Button type="submit">Save</Button>
    </Card>
  );
}

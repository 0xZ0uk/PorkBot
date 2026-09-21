// A deliberate AGENTS.md violation: a surface drawing its own field wrapper
// and control instead of importing Field and Input from @porkbot/ui.
export function NameField() {
  return (
    <label className="field">
      <span>Name</span>
      <input name="name" />
    </label>
  );
}

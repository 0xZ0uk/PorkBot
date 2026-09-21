// A deliberate AGENTS.md violation: a surface drawing the card chrome itself
// instead of importing Card from @porkbot/ui.
export function Notice() {
  return (
    <div className="card">
      <p>Server unreachable</p>
    </div>
  );
}

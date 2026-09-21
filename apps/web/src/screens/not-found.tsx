import { Card } from "@porkbot/ui";

/** A route that does not exist, in the same frame as every other screen. */
export function NotFoundScreen() {
  return (
    <main id="main" className="screen" tabIndex={-1}>
      <Card className="frame-card">
        <h1>Page not found</h1>
        <p className="muted">That page does not exist.</p>
      </Card>
    </main>
  );
}

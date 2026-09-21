import { Button, Card } from "@porkbot/ui";

/**
 * The session read failed, so the shell does not know whether the visitor is
 * signed in. Saying "signed out" here would be a lie; the screen instead says
 * the server could not be reached and offers one retry.
 */
export function UnavailableScreen({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <main id="main" className="screen" tabIndex={-1}>
      <Card className="frame-card">
        <h1>Can’t reach the server</h1>
        <p className="muted">PorkBot could not check your session.</p>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </Card>
    </main>
  );
}

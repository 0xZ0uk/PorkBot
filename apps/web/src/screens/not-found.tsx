import { Card } from "@porkbot/ui";

/** A route that does not exist, in the same frame as every other screen. */
export function NotFoundScreen() {
  return (
    <main id="main" className="flex min-h-full flex-col items-center justify-center gap-4 p-4" tabIndex={-1}>
      <Card className="w-full max-w-sm">
        <h1>Page not found</h1>
        <p className="text-muted-foreground">That page does not exist.</p>
      </Card>
    </main>
  );
}

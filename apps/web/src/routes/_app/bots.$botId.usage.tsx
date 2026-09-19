import { Link, createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { UsageScreen } from "../../screens/usage.tsx";

/**
 * One bot's usage. The loader reads the contract's answer through the usage
 * transport, so a refusal shows this route's error component instead of a
 * half-rendered table, and the screen stays a function of the data.
 */
export const Route = createFileRoute("/_app/bots/$botId/usage")({
  loader: ({ context, params }) => context.usage.forBot(params.botId),
  component: UsageRoute,
  errorComponent: UsageUnavailable,
});

function UsageRoute() {
  const usage = Route.useLoaderData();

  return (
    <>
      <p className="muted">
        <Link to="/">Back to bots</Link>
      </p>
      <UsageScreen usage={usage} />
    </>
  );
}

/** A usage read that failed: one sentence and one retry. */
function UsageUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        Usage could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

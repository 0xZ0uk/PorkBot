import { createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { UsageScreen } from "../../screens/usage.tsx";
import { UsageSkeleton } from "../../screens/loading.tsx";

/**
 * One bot's usage. The loader reads the contract's answer through the usage
 * transport, so a refusal shows this route's error component instead of a
 * half-rendered report, and the screen stays a function of the data.
 */
export const Route = createFileRoute("/_app/bots/$botId/usage")({
  pendingComponent: UsageSkeleton,
  loader: ({ context, params }) => context.usage.forBot(params.botId),
  component: UsageRoute,
  errorComponent: UsageUnavailable,
});

function UsageRoute() {
  const usage = Route.useLoaderData();

  return <UsageScreen usage={usage} />;
}

/** A usage read that failed: one sentence and one retry. */
function UsageUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <p className="rounded-md border border-destructive bg-card p-2 text-foreground" role="alert">
        Usage could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

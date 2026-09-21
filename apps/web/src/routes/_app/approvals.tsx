import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { ApprovalsScreen } from "../../screens/approvals.tsx";

export const Route = createFileRoute("/_app/approvals")({
  loader: async ({ context }) => {
    if (context.approvals === undefined) {
      throw new Error("the approval transport is not configured");
    }

    const [approvals, activeBots, archivedBots] = await Promise.all([
      context.approvals.list(),
      context.bots.listBots("active"),
      context.bots.listBots("archived"),
    ]);

    return { approvals, bots: [...activeBots, ...archivedBots] };
  },
  component: ApprovalsRoute,
  errorComponent: ApprovalsUnavailable,
});

function ApprovalsRoute() {
  const { approvals: initial, bots } = Route.useLoaderData();
  const { approvals } = Route.useRouteContext();
  const router = useRouter();

  if (approvals === undefined) {
    return <ApprovalsUnavailable reset={() => undefined} />;
  }

  return (
    <ApprovalsScreen
      approvals={initial}
      bots={bots}
      onDecision={async (input) => {
        const result = await approvals.decide(input);
        // The shell's pending count re-reads with the decision, so the rail's
        // badge drops in the same act that settles the card.
        await router.invalidate();

        return result.approval;
      }}
    />
  );
}

function ApprovalsUnavailable({ reset }: { readonly reset: () => void }) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        The approval history could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { AccountScreen } from "../../screens/account.tsx";

/**
 * The account settings route. The loader reads the contract's answer — the
 * actor's role and the deployment's owner — so a refusal renders this route's
 * error component instead of a half-rendered table, and the screen stays a
 * function of the data.
 */
export const Route = createFileRoute("/_app/settings/account")({
  loader: ({ context }) => {
    if (context.ownership === undefined) {
      throw new Error("the ownership transport is not configured");
    }

    return context.ownership.ownership();
  },
  component: AccountRoute,
  errorComponent: AccountUnavailable,
});

function AccountRoute() {
  const ownership = Route.useLoaderData();

  return <AccountScreen role={ownership.role} ownerEmail={ownership.ownerEmail} />;
}

/** An ownership read that failed: one sentence and one retry. */
function AccountUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        Account details could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

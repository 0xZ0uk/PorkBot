import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authErrorMessage } from "../../refusal.ts";
import { SignUpScreen } from "../../screens/sign-up.tsx";
import type { Registration } from "../../session.ts";

/**
 * Registration. The guard refuses to render the form unless the deployment
 * says signups are open; the API's gate still decides, so a deployment that
 * closed between the check and the submit answers the refusal the screen
 * shows.
 */
export const Route = createFileRoute("/_auth/sign-up")({
  beforeLoad: async ({ context }) => {
    const signup = await context.auth.signupAvailability();

    if (signup !== "open") {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: SignUpRoute,
});

function SignUpRoute() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function signUp(registration: Registration): Promise<void> {
    setError(null);

    try {
      await session.signUp(registration);
      await navigate({ to: "/" });
    } catch (refusal) {
      setError(authErrorMessage(refusal));
    }
  }

  return (
    <SignUpScreen
      error={error}
      onSubmit={signUp}
      footer={<Link to="/sign-in">Sign in instead</Link>}
    />
  );
}

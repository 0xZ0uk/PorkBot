import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authErrorMessage } from "../../refusal.ts";
import { SignInScreen } from "../../screens/sign-in.tsx";
import type { Credentials } from "../../session.ts";

/**
 * Sign-in. The loader asks the one public contract question — whether this
 * deployment accepts signups — and the screen hides the registration link
 * unless the answer is `open`; the form itself is the only intent the shell
 * sends, and the API's auth handler owns the credential exchange.
 */
export const Route = createFileRoute("/_auth/sign-in")({
  loader: async ({ context }) => ({ signup: await context.auth.signupAvailability() }),
  component: SignInRoute,
});

function SignInRoute() {
  const { session } = Route.useRouteContext();
  const { signup } = Route.useLoaderData();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function signIn(credentials: Credentials): Promise<void> {
    setError(null);

    try {
      await session.signIn(credentials);
      // The guard on `/_app` reads the controller, so the navigation is all it
      // takes to render the signed-in console.
      await navigate({ to: "/" });
    } catch (refusal) {
      setError(authErrorMessage(refusal));
    }
  }

  return (
    <SignInScreen
      error={error}
      signup={signup}
      onSubmit={signIn}
      footer={<Link to="/sign-up">Create an account</Link>}
    />
  );
}

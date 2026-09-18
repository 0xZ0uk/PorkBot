import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The signed-out layout: sign-in and sign-up. A visitor who already has a
 * session is sent to the console instead of a form that would replace it.
 */
export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ context }) => {
    const session = await context.session.ensure();

    if (session.status === "signed-in") {
      throw redirect({ to: "/" });
    }
  },
  component: Outlet,
});

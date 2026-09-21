import { Outlet, createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { emptyRoster, readRoster } from "../roster.ts";
import { UnavailableScreen } from "../screens/unavailable.tsx";
import { Workspace } from "../shell/workspace.tsx";

/**
 * The layout every signed-in screen renders in: the three-pane workspace, with
 * the roster and the pending approvals it needs (slices 13.4 and 13.6).
 *
 * Its guard is the shell's authorization: the session is resolved before a
 * child route renders, a signed-out visitor is redirected to sign-in, and a
 * session read that failed renders the unavailable screen rather than a
 * signed-out lie. The roster read is deliberately not fatal — a rail that
 * cannot list bots must not take the content pane down with it — so a failure
 * becomes an empty rail that says so and offers the retry.
 *
 * The roster is read once here and handed to the rail and the home screen
 * alike, so both list the same rows: the bot, its identity, its state and its
 * latest activity come from one read rather than two shapes that can drift.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.session.ensure();

    if (session.status === "signed-out") {
      throw redirect({ to: "/sign-in" });
    }

    return { sessionState: session };
  },
  loader: async ({ context }) => {
    try {
      const pendingApprovals =
        context.approvals === undefined ? [] : await context.approvals.list({ status: "pending" });
      const roster = await readRoster(context.bots, pendingApprovals);

      return { roster, pendingApprovals, rosterFailed: false };
    } catch {
      return { roster: emptyRoster, pendingApprovals: [], rosterFailed: true };
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { session, sessionState } = Route.useRouteContext();
  const { roster, pendingApprovals, rosterFailed } = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();

  async function signOut(): Promise<void> {
    try {
      await session.signOut();
      await navigate({ to: "/sign-in" });
    } catch {
      // A sign-out that did not complete leaves the session possibly live; the
      // shell re-reads it rather than claiming a state the server did not.
      await session.reload();
      await router.invalidate();
    }
  }

  if (sessionState.status === "unavailable") {
    return (
      <UnavailableScreen
        onRetry={() => {
          void session.reload().then(() => router.invalidate());
        }}
      />
    );
  }

  return (
    <Workspace
      roster={roster}
      pendingApprovals={pendingApprovals}
      rosterFailed={rosterFailed}
      onRetryRoster={() => {
        void router.invalidate();
      }}
      onSignOut={() => {
        void signOut();
      }}
    >
      <Outlet />
    </Workspace>
  );
}

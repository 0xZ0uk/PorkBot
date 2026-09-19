import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { UnavailableScreen } from "../screens/unavailable.tsx";

/**
 * The layout every signed-in screen renders in. Its guard is the shell's
 * authorization: the session is resolved before a child route renders, a
 * signed-out visitor is redirected to sign-in, and a session read that failed
 * renders the unavailable screen rather than a signed-out lie.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.session.ensure();

    if (session.status === "signed-out") {
      throw redirect({ to: "/sign-in" });
    }

    return { sessionState: session };
  },
  component: AppLayout,
});

function AppLayout() {
  const { session, sessionState } = Route.useRouteContext();
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
    <>
      <header className="app-header">
        <h1>PorkBot</h1>
        <div className="app-header-actions">
          <Link to="/settings/connections">Connections</Link>
          <Button
            onClick={() => {
              void signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </header>
      {/* Focusable so the skip link and programmatic focus land somewhere
          meaningful; the signed-in screens render inside it. */}
      <main id="main" className="app-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { ThreadConsoleScreen } from "../../screens/thread-console.tsx";
import { useThreadConsole } from "../../use-console.ts";

/**
 * One thread's console. The route is only the wiring: the thread id comes from
 * the URL, the transport from the router context, and everything the screen
 * shows is the console controller's state. A reload of this route starts a
 * fresh console, which replays the thread's durable events from zero — the
 * resume path story 19 asks for.
 */
export const Route = createFileRoute("/_app/threads/$threadId")({
  component: ThreadConsoleRoute,
});

function ThreadConsoleRoute() {
  const { threadId } = Route.useParams();
  const { threads } = Route.useRouteContext();
  const { state, retry } = useThreadConsole({ transport: threads, threadId });

  return <ThreadConsoleScreen state={state} onRetry={retry} />;
}

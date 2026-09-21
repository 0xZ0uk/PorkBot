import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { HomeScreen } from "../../screens/home.tsx";
import { RosterSkeleton } from "../../screens/loading.tsx";

/**
 * The roster's home route (slice 13.6). The roster itself is read by the shell
 * layout so the rail and this screen list the same rows; the route owns the
 * writes a row can make — a new thread, a pin, an archive and a restore — and
 * hands the outcome back through the router's invalidate, so both surfaces
 * reload the roster the write produced.
 */

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/")({
  pendingComponent: RosterSkeleton,
  component: HomeRoute,
});

function HomeRoute() {
  const { roster, rosterFailed } = appRoute.useLoaderData();
  const { bots: botsTransport, threads } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [pendingBotId, setPendingBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createThread(botId: string): Promise<void> {
    setPendingBotId(botId);
    setError(null);

    try {
      const thread = await threads.createThread(botId);
      await navigate({
        to: "/bots/$botId/threads/$threadId",
        params: { botId, threadId: thread.id },
      });
    } catch {
      setError("The thread could not be started. Try again.");
    } finally {
      setPendingBotId(null);
    }
  }

  async function changePin(botId: string, pinned: boolean): Promise<void> {
    setPendingBotId(botId);
    setError(null);

    try {
      await botsTransport.setPinned(botId, pinned);
      await router.invalidate();
    } catch {
      setError("The bot could not be pinned. Try again.");
    } finally {
      setPendingBotId(null);
    }
  }

  async function changeArchive(botId: string, action: "archive" | "restore"): Promise<void> {
    setPendingBotId(botId);
    setError(null);

    try {
      await (action === "archive"
        ? botsTransport.archiveBot(botId)
        : botsTransport.restoreBot(botId));
      await router.invalidate();
    } catch {
      setError(
        action === "archive"
          ? "The bot could not be archived. Try again."
          : "The bot could not be restored. Try again.",
      );
    } finally {
      setPendingBotId(null);
    }
  }

  return (
    <HomeScreen
      roster={roster}
      failed={rosterFailed}
      onRetry={() => {
        void router.invalidate();
      }}
      pendingBotId={pendingBotId}
      error={error}
      onCreate={() => {
        void navigate({ to: "/bots/new" });
      }}
      onNewThread={(botId) => void createThread(botId)}
      onArchive={(botId) => changeArchive(botId, "archive")}
      onRestore={(botId) => changeArchive(botId, "restore")}
      onPin={(botId, pinned) => void changePin(botId, pinned)}
    />
  );
}

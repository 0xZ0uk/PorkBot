import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { useState } from "react";
import { HomeScreen } from "../../screens/home.tsx";

/**
 * The signed-in home: the actor's bots, their recent threads, and the one
 * action that opens the console. The loader reads bots and threads through the
 * console transport, so the guards, the console and this screen all consume
 * the same derived client and a refusal shows the route's error component
 * rather than a half-rendered list.
 */
export const Route = createFileRoute("/_app/")({
  loader: async ({ context }) => {
    const bots = await context.threads.listBots();
    const groups = await Promise.all(
      bots.map(async (bot) => ({ bot, threads: await context.threads.listThreads(bot.id) })),
    );

    return { bots: groups };
  },
  component: HomeRoute,
  errorComponent: HomeUnavailable,
});

function HomeRoute() {
  const { bots } = Route.useLoaderData();
  const { threads: transport } = Route.useRouteContext();
  const navigate = useNavigate();
  const [pendingBotId, setPendingBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createThread(botId: string): Promise<void> {
    setPendingBotId(botId);
    setError(null);

    try {
      const thread = await transport.createThread(botId);

      await navigate({ to: "/threads/$threadId", params: { threadId: thread.id } });
    } catch {
      setError("The thread could not be started.");
    } finally {
      setPendingBotId(null);
    }
  }

  return (
    <HomeScreen
      bots={bots}
      pendingBotId={pendingBotId}
      error={error}
      onNewThread={(botId) => {
        void createThread(botId);
      }}
      renderMemory={(bot) => (
        <Link to="/bots/$botId/memory" params={{ botId: bot.id }}>
          Memory
        </Link>
      )}
      renderUsage={(bot) => (
        <Link to="/bots/$botId/usage" params={{ botId: bot.id }}>
          Usage
        </Link>
      )}
      renderThread={(thread) => (
        <li key={thread.id}>
          <Link to="/threads/$threadId" params={{ threadId: thread.id }}>
            Thread · {new Date(thread.updatedAt).toLocaleString()}
          </Link>
        </li>
      )}
    />
  );
}

/** A bot or thread read that failed: one sentence and one retry. */
function HomeUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        The console could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

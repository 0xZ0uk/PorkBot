import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { useState } from "react";
import { BotOverviewScreen } from "../../screens/bot-overview.tsx";
import { BotOverviewSkeleton } from "../../screens/loading.tsx";

/**
 * A bot's own screen, under its id: what the rail's rows open. The loader
 * reads the bot and its threads through the actor-scoped transport, so a bot
 * outside the actor's space is the API's typed not-found and the error
 * component answers it.
 */
export const Route = createFileRoute("/_app/bots/$botId/")({
  pendingComponent: BotOverviewSkeleton,
  loader: async ({ context, params }) => {
    const [bot, threads] = await Promise.all([
      context.bots.getBot(params.botId),
      context.threads.listThreads(params.botId),
    ]);

    return { bot, threads };
  },
  component: BotOverviewRoute,
  errorComponent: BotOverviewUnavailable,
});

function BotOverviewRoute() {
  const { bot, threads } = Route.useLoaderData();
  const { threads: transport } = Route.useRouteContext();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createThread(): Promise<void> {
    setCreating(true);
    setError(null);

    try {
      const thread = await transport.createThread(bot.id);

      await navigate({
        to: "/bots/$botId/threads/$threadId",
        params: { botId: bot.id, threadId: thread.id },
      });
    } catch {
      setError("The thread could not be started. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <BotOverviewScreen
      bot={bot}
      threads={threads}
      creating={creating}
      error={error}
      onNewThread={() => {
        void createThread();
      }}
    />
  );
}

function BotOverviewUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        The bot could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

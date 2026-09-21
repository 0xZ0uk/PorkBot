import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { useState } from "react";
import { latestActivity, readComputerHealth } from "../../bots.ts";
import type { BotListItem, BotsTransport } from "../../bots.ts";
import { HomeScreen } from "../../screens/home.tsx";
import type { Bot } from "@porkbot/contracts";

export const Route = createFileRoute("/_app/")({
  loader: async ({ context }) => {
    const [activeBots, archivedBots, sections] = await Promise.all([
      context.bots.listBots("active"),
      context.bots.listBots("archived"),
      context.bots.listSections(),
    ]);
    const [active, archived] = await Promise.all([
      enrichBots(context.bots, activeBots),
      enrichBots(context.bots, archivedBots),
    ]);

    return { active, archived, sections };
  },
  component: HomeRoute,
  errorComponent: HomeUnavailable,
});

async function enrichBots(
  transport: BotsTransport,
  bots: readonly Bot[],
): Promise<readonly BotListItem[]> {
  return Promise.all(
    bots.map(async (bot) => {
      const [threads, computer, avatarUrl] = await Promise.all([
        transport.listThreads(bot.id),
        readComputerHealth(transport, bot.id),
        readAvatarUrl(transport, bot),
      ]);

      return { bot, avatarUrl, threads, computer, lastActivityAt: latestActivity(threads) };
    }),
  );
}

async function readAvatarUrl(transport: BotsTransport, bot: Bot): Promise<string | null> {
  if (bot.avatarKey === null) {
    return null;
  }

  try {
    const avatar = await transport.readAvatar(bot.id);
    return `data:${avatar.contentType};base64,${avatar.data}`;
  } catch {
    // A missing object is treated like no avatar so the generated identity
    // remains available while storage is repaired or an upload is retried.
    return null;
  }
}

function HomeRoute() {
  const { active, archived, sections } = Route.useLoaderData();
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
      active={active}
      archived={archived}
      sections={sections}
      pendingBotId={pendingBotId}
      error={error}
      onNewThread={(botId) => void createThread(botId)}
      onArchive={(botId) => changeArchive(botId, "archive")}
      onRestore={(botId) => changeArchive(botId, "restore")}
      renderCreate={() => <Link to="/bots/new">New bot</Link>}
      renderEdit={(bot) => (
        <Link to="/bots/$botId/edit" params={{ botId: bot.id }}>
          Edit
        </Link>
      )}
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
      renderComputer={(bot) => (
        <Link to="/bots/$botId/computer" params={{ botId: bot.id }}>
          Computer
        </Link>
      )}
      renderThread={(thread) => (
        <li key={thread.id}>
          <Link
            to="/bots/$botId/threads/$threadId"
            params={{ botId: thread.botId, threadId: thread.id }}
          >
            Thread · {new Date(thread.updatedAt).toLocaleString()}
          </Link>
        </li>
      )}
    />
  );
}

function HomeUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        The bot list could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}

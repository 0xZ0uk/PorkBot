import { Link } from "@tanstack/react-router";
import type { Bot, Thread } from "@porkbot/contracts";
import { Button } from "@porkbot/ui";

/**
 * A bot's own screen (slice 13.4): what it is for, the threads it has, and the
 * one action that starts work. It is deliberately thin — the roster slice
 * rebuilds the rows and the conversation slice rebuilds the thread — but it is
 * what the rail's rows open, so the content pane always has the bot's own
 * screen behind the selected row.
 */

export interface BotOverviewScreenProps {
  readonly bot: Bot;
  readonly threads: readonly Thread[];
  readonly creating: boolean;
  readonly error: string | null;
  readonly onNewThread: () => void;
}

export function BotOverviewScreen({
  bot,
  threads,
  creating,
  error,
  onNewThread,
}: BotOverviewScreenProps) {
  return (
    <section className="console bot-overview">
      {bot.description === "" ? null : <p className="muted">{bot.description}</p>}
      <div className="bot-overview-actions">
        <Button variant="primary" loading={creating} onClick={onNewThread}>
          New thread
        </Button>
      </div>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <h2>Threads</h2>
      {threads.length === 0 ? (
        <div className="empty-state">
          <h3>No threads yet</h3>
          <p className="muted">Start one and this bot gets to work.</p>
        </div>
      ) : (
        <ul className="thread-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link
                to="/bots/$botId/threads/$threadId"
                params={{ botId: bot.id, threadId: thread.id }}
              >
                Thread · {new Date(thread.updatedAt).toLocaleString()}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

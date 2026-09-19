import { Button } from "@porkbot/ui";
import type { ReactNode } from "react";
import type { Bot, Thread } from "@porkbot/contracts";

/**
 * The signed-in console's entry point: the actor's bots, each with its recent
 * threads and one way to start a new one. It is deliberately the smallest
 * thing that makes the thread console reachable — the bot editor, sections and
 * avatars are slice 11.2 — so it lists, links and starts threads and nothing
 * more. The thread link itself is a render prop because routing belongs to the
 * route, and this screen stays a plain function of its props.
 */

export interface BotWithThreads {
  readonly bot: Bot;
  readonly threads: readonly Thread[];
}

export interface HomeScreenProps {
  readonly bots: readonly BotWithThreads[];
  /** The bot whose thread is being created, for the button's pending state. */
  readonly pendingBotId: string | null;
  /** A refusal sentence for a create that failed, or `null`. */
  readonly error: string | null;
  readonly onNewThread: (botId: string) => void;
  readonly renderThread: (thread: Thread) => ReactNode;
}

export function HomeScreen({
  bots,
  pendingBotId,
  error,
  onNewThread,
  renderThread,
}: HomeScreenProps) {
  return (
    <section className="console">
      <h2>Bots</h2>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {bots.length === 0 ? (
        <p className="muted">No bots yet.</p>
      ) : (
        <ul className="bot-list">
          {bots.map(({ bot, threads }) => (
            <li key={bot.id} className="bot">
              <div className="bot-header">
                <h3>{bot.name}</h3>
                <Button disabled={pendingBotId === bot.id} onClick={() => onNewThread(bot.id)}>
                  New thread
                </Button>
              </div>
              {threads.length === 0 ? null : (
                <ul className="thread-list">{threads.map((thread) => renderThread(thread))}</ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

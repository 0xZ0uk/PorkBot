import { Button } from "@porkbot/ui";
import { useState } from "react";
import type { Roster, RosterGroup } from "../roster.ts";
import { groupRoster } from "../roster.ts";
import { RosterRow } from "../shell/roster-row.tsx";

/**
 * The roster's home (slice 13.6): the same rows the rail shows, at card size
 * and grouped — pinned, then the operator's sections, then the archived group
 * behind a toggle. The rows carry the actions (open, new thread, edit, memory,
 * usage, pin, archive) behind a menu, and every empty state names what to do
 * next rather than what is missing.
 */

export interface HomeScreenProps {
  readonly roster: Roster;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly pendingBotId: string | null;
  readonly error: string | null;
  readonly onCreate: () => void;
  readonly onNewThread: (botId: string) => void;
  readonly onArchive: (botId: string) => Promise<void>;
  readonly onRestore: (botId: string) => Promise<void>;
  readonly onPin: (botId: string, pinned: boolean) => void;
}

export function HomeScreen({
  roster,
  failed,
  onRetry,
  pendingBotId,
  error,
  onCreate,
  onNewThread,
  onArchive,
  onRestore,
  onPin,
}: HomeScreenProps) {
  const [showArchived, setShowArchived] = useState(false);
  const groups = groupRoster(roster.active, roster.sections);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <h2>Bots</h2>
        <Button variant="primary" onClick={onCreate}>
          New bot
        </Button>
      </header>

      {error === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {error}
        </p>
      )}

      {failed ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <h3>The bot list could not be loaded</h3>
          <p className="text-muted-foreground">Check your connection and try again.</p>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : roster.active.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <h3>Create your first bot</h3>
          <p className="text-muted-foreground">
            Give it a name and instructions, then start its first thread.
          </p>
          <Button variant="primary" onClick={onCreate}>
            New bot
          </Button>
        </div>
      ) : (
        groups.map((group) => (
          <RosterGroupSection
            key={group.id}
            group={group}
            pendingBotId={pendingBotId}
            onNewThread={onNewThread}
            onArchive={onArchive}
            onRestore={onRestore}
            onPin={onPin}
          />
        ))
      )}

      {roster.archived.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <Button
            aria-expanded={showArchived}
            onClick={() => {
              setShowArchived(!showArchived);
            }}
          >
            {showArchived ? "Hide archived" : `Archived (${String(roster.archived.length)})`}
          </Button>
          {showArchived ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {roster.archived.map((entry) => (
                <li key={entry.bot.id}>
                  <RosterRow
                    entry={entry}
                    size="home"
                    pending={pendingBotId === entry.bot.id}
                    onRestore={onRestore}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </section>
  );
}

interface RosterGroupSectionProps {
  readonly group: RosterGroup;
  readonly pendingBotId: string | null;
  readonly onNewThread: (botId: string) => void;
  readonly onArchive: (botId: string) => Promise<void>;
  readonly onRestore: (botId: string) => Promise<void>;
  readonly onPin: (botId: string, pinned: boolean) => void;
}

function RosterGroupSection({
  group,
  pendingBotId,
  onNewThread,
  onArchive,
  onRestore,
  onPin,
}: RosterGroupSectionProps) {
  return (
    <section className="flex flex-col gap-2">
      {group.name === null ? null : <h3>{group.name}</h3>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {group.entries.map((entry) => (
          <li key={entry.bot.id}>
            <RosterRow
              entry={entry}
              size="home"
              pending={pendingBotId === entry.bot.id}
              onNewThread={onNewThread}
              onArchive={onArchive}
              onRestore={onRestore}
              onPin={onPin}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

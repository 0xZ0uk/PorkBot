import { Link, useNavigate } from "@tanstack/react-router";
import { BotAvatar, Button, Menu, StateChip } from "@porkbot/ui";
import type { MenuItem } from "@porkbot/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import { absoluteTime, relativeTime } from "../roster.ts";
import type { RosterEntry } from "../roster.ts";
import type { Bot } from "@porkbot/contracts";

/**
 * The roster row (slice 13.6): one component for the rail, the home screen and
 * the archived group, so the three cannot drift. The rail's size is the dense
 * row the switcher sheet also shows; the home's size is the same row at card
 * scale, with the actions the operator reaches for behind a menu rather than a
 * line of underlined links.
 *
 * The identity block is the link a pointer and a keyboard both take; every
 * other action is a menu item, and nothing on the row is a bare anchor. The
 * archive action asks once before it writes; restore is one step because it
 * only puts a bot back.
 */

export type RosterRowSize = "rail" | "home";

export interface RosterRowProps {
  readonly entry: RosterEntry;
  readonly size: RosterRowSize;
  /** The bot has an in-flight write; its actions wait for it. */
  readonly pending?: boolean | undefined;
  readonly onNewThread?: ((botId: string) => void) | undefined;
  readonly onArchive?: ((botId: string) => Promise<void>) | undefined;
  readonly onRestore?: ((botId: string) => Promise<void>) | undefined;
  readonly onPin?: ((botId: string, pinned: boolean) => void) | undefined;
  /** Closes the switcher sheet after a navigation; absent in the wide rail. */
  readonly onNavigate?: (() => void) | undefined;
}

export function RosterRow({
  entry,
  size,
  pending = false,
  onNewThread,
  onArchive,
  onRestore,
  onPin,
  onNavigate,
}: RosterRowProps) {
  const { bot } = entry;

  if (size === "rail") {
    return (
      <Link
        to="/bots/$botId"
        params={{ botId: bot.id }}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent aria-[current=page]:bg-accent"
        onClick={onNavigate}
      >
        <BotAvatar
          id={bot.id}
          name={bot.name}
          color={bot.color}
          imageUrl={entry.avatarUrl}
          size={24}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-foreground" data-name>{bot.name}</span>
          <span className="truncate text-meta text-muted-foreground">{roleOf(bot)}</span>
          <span className="truncate text-meta text-muted-foreground">
            <Activity entry={entry} />
          </span>
        </span>
        <StateChip
          state={entry.state}
          color={bot.color}
          count={entry.state === "waiting" ? entry.waiting : undefined}
        />
      </Link>
    );
  }

  return (
    <HomeRow
      entry={entry}
      pending={pending}
      onNewThread={onNewThread}
      onArchive={onArchive}
      onRestore={onRestore}
      onPin={onPin}
      onNavigate={onNavigate}
    />
  );
}

interface HomeRowProps {
  readonly entry: RosterEntry;
  readonly pending?: boolean | undefined;
  readonly onNewThread?: ((botId: string) => void) | undefined;
  readonly onArchive?: ((botId: string) => Promise<void>) | undefined;
  readonly onRestore?: ((botId: string) => Promise<void>) | undefined;
  readonly onPin?: ((botId: string, pinned: boolean) => void) | undefined;
  readonly onNavigate?: (() => void) | undefined;
}

function HomeRow({
  entry,
  pending = false,
  onNewThread,
  onArchive,
  onRestore,
  onPin,
  onNavigate,
}: HomeRowProps) {
  const { bot } = entry;
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const archived = bot.archivedAt !== null;
  const open: MenuItem = {
    id: "open",
    label: "Open",
    onSelect: () => {
      void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
    },
  };
  const edit: MenuItem = {
    id: "edit",
    label: "Edit",
    onSelect: () => {
      void navigate({ to: "/bots/$botId/edit", params: { botId: bot.id } });
    },
  };
  async function confirmArchive(): Promise<void> {
    try {
      await onArchive?.(bot.id);
    } finally {
      // The write is the route's; the row closes its own question either way
      // and a failure surfaces as the screen's error with the action still in
      // the menu.
      setConfirming(false);
    }
  }

  // An archived bot is out of the way: it can be opened, edited and restored,
  // and it grows no new threads until it is back on the roster.
  const actions: readonly MenuItem[] = archived
    ? [
        open,
        edit,
        {
          id: "restore",
          label: "Restore",
          disabled: pending || onRestore === undefined,
          onSelect: () => {
            void onRestore?.(bot.id);
          },
        },
      ]
    : [
        open,
        {
          id: "new-thread",
          label: "New thread",
          disabled: pending || onNewThread === undefined,
          onSelect: () => {
            onNewThread?.(bot.id);
          },
        },
        edit,
        {
          id: "memory",
          label: "Memory",
          onSelect: () => {
            void navigate({ to: "/bots/$botId/memory", params: { botId: bot.id } });
          },
        },
        {
          id: "routines",
          label: "Routines",
          onSelect: () => {
            void navigate({ to: "/bots/$botId/routines", params: { botId: bot.id } });
          },
        },
        {
          id: "usage",
          label: "Usage",
          onSelect: () => {
            void navigate({ to: "/bots/$botId/usage", params: { botId: bot.id } });
          },
        },
        {
          id: "pin",
          label: bot.pinned ? "Unpin" : "Pin",
          disabled: pending || onPin === undefined,
          onSelect: () => {
            onPin?.(bot.id, !bot.pinned);
          },
        },
        {
          id: "archive",
          label: "Archive",
          destructive: true,
          disabled: pending || onArchive === undefined,
          onSelect: () => {
            setConfirming(true);
          },
        },
      ];

  return (
    <article className="roster-card">
      <div className="roster-card-head">
        <Link
          to="/bots/$botId"
          params={{ botId: bot.id }}
          className="roster-card-identity"
          onClick={onNavigate}
        >
          <BotAvatar
            id={bot.id}
            name={bot.name}
            color={bot.color}
            imageUrl={entry.avatarUrl}
            size={40}
          />
          <span className="roster-card-body">
            <span className="roster-card-name">{bot.name}</span>
            <span className="roster-card-role">{roleOf(bot)}</span>
          </span>
        </Link>
        <StateChip
          state={entry.state}
          color={bot.color}
          count={entry.state === "waiting" ? entry.waiting : undefined}
        />
        <Menu label="Actions" ariaLabel={`Actions for ${bot.name}`} items={actions} align="end" />
      </div>

      <p className="roster-card-activity">
        <Activity entry={entry} />
      </p>

      {confirming ? (
        <div className="roster-confirm">
          <p className="muted">Archive this bot? Its threads and settings will be kept.</p>
          <div className="roster-confirm-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                void confirmArchive();
              }}
            >
              Confirm archive
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Activity({ entry }: Readonly<{ entry: RosterEntry }>): ReactNode {
  const { summary, at } = entry.activity;

  return (
    <>
      {summary}
      {at === null ? null : (
        <>
          {" · "}
          <time dateTime={at} title={absoluteTime(at)}>
            {relativeTime(at)}
          </time>
        </>
      )}
    </>
  );
}

function roleOf(bot: Bot): string {
  return bot.title === "" ? "Bot" : bot.title;
}

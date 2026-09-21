import { BotAvatar, Button } from "@porkbot/ui";
import { useState } from "react";
import type { Bot, BotSection, Thread } from "@porkbot/contracts";
import type { ReactNode } from "react";
import type { BotListItem, ComputerHealth } from "../bots.ts";

export interface HomeScreenProps {
  readonly active: readonly BotListItem[];
  readonly archived: readonly BotListItem[];
  readonly sections: readonly BotSection[];
  readonly pendingBotId: string | null;
  readonly error: string | null;
  readonly onNewThread: (botId: string) => void;
  readonly onArchive: (botId: string) => Promise<void>;
  readonly onRestore: (botId: string) => Promise<void>;
  readonly renderCreate: () => ReactNode;
  readonly renderEdit: (bot: Bot) => ReactNode;
  readonly renderMemory: (bot: Bot) => ReactNode;
  readonly renderUsage: (bot: Bot) => ReactNode;
  /** The link into one bot's computer settings, rendered by the route. */
  readonly renderComputer: (bot: Bot) => ReactNode;
  readonly renderThread: (thread: Thread) => ReactNode;
}

export function HomeScreen({
  active,
  archived,
  sections,
  pendingBotId,
  error,
  onNewThread,
  onArchive,
  onRestore,
  renderCreate,
  renderEdit,
  renderMemory,
  renderUsage,
  renderComputer,
  renderThread,
}: HomeScreenProps) {
  const [showArchived, setShowArchived] = useState(false);

  return (
    <section className="console bot-home">
      <header className="memory-header">
        <div>
          <h2>Bots</h2>
          <p className="muted">Your teammates and what they are doing.</p>
        </div>
        {renderCreate()}
      </header>

      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {active.length === 0 ? (
        <div className="empty-state">
          <h3>Create your first bot</h3>
          <p className="muted">Give it a name and instructions, then start a thread.</p>
          {renderCreate()}
        </div>
      ) : (
        <BotGroups
          items={active}
          sections={sections}
          pendingBotId={pendingBotId}
          onNewThread={onNewThread}
          onArchive={onArchive}
          renderEdit={renderEdit}
          renderMemory={renderMemory}
          renderUsage={renderUsage}
          renderComputer={renderComputer}
          renderThread={renderThread}
        />
      )}

      {archived.length === 0 ? null : (
        <section className="archived-bots">
          <Button
            onClick={() => {
              setShowArchived(!showArchived);
            }}
          >
            {showArchived ? "Hide archived" : `Archived (${String(archived.length)})`}
          </Button>
          {showArchived ? (
            <ul className="bot-list">
              {archived.map((item) => (
                <BotCard
                  key={item.bot.id}
                  item={item}
                  pending={pendingBotId === item.bot.id}
                  archived
                  onNewThread={onNewThread}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  renderEdit={renderEdit}
                  renderMemory={renderMemory}
                  renderUsage={renderUsage}
                  renderComputer={renderComputer}
                  renderThread={renderThread}
                />
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </section>
  );
}

interface BotGroupsProps {
  readonly items: readonly BotListItem[];
  readonly sections: readonly BotSection[];
  readonly pendingBotId: string | null;
  readonly onNewThread: (id: string) => void;
  readonly onArchive: (id: string) => Promise<void>;
  readonly renderEdit: (bot: Bot) => ReactNode;
  readonly renderMemory: (bot: Bot) => ReactNode;
  readonly renderUsage: (bot: Bot) => ReactNode;
  readonly renderComputer: (bot: Bot) => ReactNode;
  readonly renderThread: (thread: Thread) => ReactNode;
}

function BotGroups(props: BotGroupsProps) {
  const known = new Set(props.sections.map((section) => section.id));
  const groups = [
    ...props.sections.map((section) => ({
      id: section.id,
      name: section.name as string | null,
      items: props.items.filter((item) => item.bot.sectionId === section.id),
    })),
    {
      id: "unfiled",
      name: props.sections.length === 0 ? null : "Unfiled",
      items: props.items.filter(
        (item) => item.bot.sectionId === null || !known.has(item.bot.sectionId),
      ),
    },
  ].filter((group) => group.items.length > 0);

  return groups.map((group) => (
    <section key={group.id} className="bot-group">
      {group.name === null ? null : <h3>{group.name}</h3>}
      <ul className="bot-list">
        {group.items.map((item) => (
          <BotCard
            key={item.bot.id}
            item={item}
            pending={props.pendingBotId === item.bot.id}
            archived={false}
            onNewThread={props.onNewThread}
            onArchive={props.onArchive}
            onRestore={async () => undefined}
            renderEdit={props.renderEdit}
            renderMemory={props.renderMemory}
            renderUsage={props.renderUsage}
            renderComputer={props.renderComputer}
            renderThread={props.renderThread}
          />
        ))}
      </ul>
    </section>
  ));
}

interface BotCardProps {
  readonly item: BotListItem;
  readonly pending: boolean;
  readonly archived: boolean;
  readonly onNewThread: (id: string) => void;
  readonly onArchive: (id: string) => Promise<void>;
  readonly onRestore: (id: string) => Promise<void>;
  readonly renderEdit: (bot: Bot) => ReactNode;
  readonly renderMemory: (bot: Bot) => ReactNode;
  readonly renderUsage: (bot: Bot) => ReactNode;
  readonly renderComputer: (bot: Bot) => ReactNode;
  readonly renderThread: (thread: Thread) => ReactNode;
}

function BotCard({
  item,
  pending,
  archived,
  onNewThread,
  onArchive,
  onRestore,
  renderEdit,
  renderMemory,
  renderUsage,
  renderComputer,
  renderThread,
}: BotCardProps) {
  const [confirming, setConfirming] = useState(false);
  const { bot, threads } = item;

  return (
    <li className={`bot bot-health-${item.computer.kind}`}>
      <div className="bot-header">
        <div className="bot-identity">
          <BotAvatar
            id={bot.id}
            name={bot.name}
            color={bot.color}
            imageUrl={item.avatarUrl}
            size={40}
          />
          <div>
            <h3>{bot.name}</h3>
            <p className="muted">{bot.title || "Bot"}</p>
          </div>
        </div>
        <Status health={item.computer} archived={archived} />
      </div>

      <p className="bot-activity muted">
        {item.lastActivityAt === null
          ? "No activity yet"
          : `Last active ${formatMoment(item.lastActivityAt)}`}
      </p>

      <div className="bot-actions">
        {renderEdit(bot)}
        {archived ? null : renderMemory(bot)}
        {archived ? null : renderUsage(bot)}
        {archived ? null : renderComputer(bot)}
        {archived ? null : (
          <Button disabled={pending} onClick={() => onNewThread(bot.id)}>
            New thread
          </Button>
        )}
        <Button
          disabled={pending}
          onClick={() => {
            setConfirming(!confirming);
          }}
        >
          {confirming ? "Cancel" : archived ? "Restore" : "Archive"}
        </Button>
      </div>

      {confirming ? (
        <div className="confirm-row">
          <p className="muted">
            {archived
              ? "Restore this bot to the active list?"
              : "Archive this bot? Its threads and settings will be kept."}
          </p>
          <Button
            disabled={pending}
            variant="primary"
            onClick={() => {
              void (archived ? onRestore(bot.id) : onArchive(bot.id));
            }}
          >
            {archived ? "Confirm restore" : "Confirm archive"}
          </Button>
        </div>
      ) : null}

      {archived || threads.length === 0 ? null : (
        <ul className="thread-list">{threads.slice(0, 3).map(renderThread)}</ul>
      )}
    </li>
  );
}

function Status({ health, archived }: Readonly<{ health: ComputerHealth; archived: boolean }>) {
  let label = "Ready";

  if (archived) {
    label = "Archived";
  } else if (health.kind === "failed") {
    label = "Computer unavailable";
  } else if (!health.view.assigned) {
    label = "No computer";
  } else if (health.kind === "stopped") {
    label = health.view.state === "gone" ? "Computer missing" : "Computer stopped";
  }

  return <span className={`bot-status bot-status-${health.kind}`}>{label}</span>;
}

function formatMoment(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

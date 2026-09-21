import { Link } from "@tanstack/react-router";
import type { Bot } from "@porkbot/contracts";
import { BotAvatar, Button, CountBadge, Icon, Input, StateChip } from "@porkbot/ui";
import type { Mode } from "./mode.ts";

/**
 * The rail: the roster and the single trips that used to be top-bar links
 * (slice 13.4; design record, Shell anatomy). One component serves the wide
 * rail and the narrow switcher sheet, so the roster cannot drift between the
 * two; the sheet passes `onNavigate` so a chosen bot closes it.
 */

export interface RailProps {
  readonly bots: readonly Bot[];
  readonly pendingByBot: ReadonlyMap<string, number>;
  readonly pendingCount: number;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly mode: Mode;
  readonly onToggleMode: () => void;
  readonly onSignOut: () => void;
  readonly rosterFailed: boolean;
  readonly onRetryRoster?: (() => void) | undefined;
  /** Closes the switcher sheet after a navigation; absent in the wide rail. */
  readonly onNavigate?: (() => void) | undefined;
}

export function Rail({
  bots,
  pendingByBot,
  pendingCount,
  query,
  onQuery,
  mode,
  onToggleMode,
  onSignOut,
  rosterFailed,
  onRetryRoster,
  onNavigate,
}: RailProps) {
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? bots
      : bots.filter((bot) => `${bot.name} ${bot.title}`.toLowerCase().includes(needle));
  const nextMode = mode === "dark" ? "light" : "dark";

  return (
    <div className="shell-rail-inner">
      <div className="shell-rail-head">
        <span className="shell-rail-brand">PorkBot</span>
        <div className="shell-rail-search">
          <Icon name="search" className="shell-rail-search-icon" />
          <Input
            type="search"
            className="shell-rail-search-input"
            placeholder="Search bots"
            aria-label="Search bots"
            value={query}
            onChange={(event) => {
              onQuery(event.target.value);
            }}
          />
        </div>
      </div>

      <nav className="shell-rail-roster" aria-label="Bots">
        {visible.map((bot) => {
          const pending = pendingByBot.get(bot.id) ?? 0;

          return (
            <Link
              key={bot.id}
              to="/bots/$botId"
              params={{ botId: bot.id }}
              className="shell-rail-row"
              onClick={onNavigate}
            >
              <BotAvatar id={bot.id} name={bot.name} color={bot.color} size={24} />
              <span className="shell-rail-row-body">
                <span className="shell-rail-row-name">{bot.name}</span>
                <span className="shell-rail-row-meta">{bot.title === "" ? "Bot" : bot.title}</span>
              </span>
              {pending > 0 ? <StateChip state="waiting" count={pending} /> : null}
            </Link>
          );
        })}
        {rosterFailed ? (
          <>
            <p className="shell-rail-empty">The bot list could not be loaded.</p>
            <Button variant="ghost" className="shell-rail-new" onClick={onRetryRoster}>
              Try again
            </Button>
          </>
        ) : null}
        {!rosterFailed && visible.length === 0 ? (
          <p className="shell-rail-empty">
            {bots.length === 0 ? "No bots yet." : "No bots match."}
          </p>
        ) : null}
        {!rosterFailed && bots.length === 0 ? (
          <Link to="/bots/new" className="shell-rail-new" onClick={onNavigate}>
            <Icon name="plus" />
            New bot
          </Link>
        ) : null}
      </nav>

      <nav className="shell-rail-foot" aria-label="Workspace">
        <Link
          to="/approvals"
          className="shell-rail-foot-row"
          onClick={onNavigate}
          aria-label={pendingCount > 0 ? `Approvals, ${String(pendingCount)} waiting` : "Approvals"}
        >
          <Icon name="alert" />
          <span className="shell-rail-foot-label">Approvals</span>
          {pendingCount > 0 ? <CountBadge count={pendingCount} /> : null}
        </Link>
        <Link to="/settings" className="shell-rail-foot-row" onClick={onNavigate}>
          <Icon name="settings" />
          <span className="shell-rail-foot-label">Settings</span>
        </Link>
        <Button
          variant="ghost"
          className="shell-rail-foot-row"
          onClick={onToggleMode}
          aria-label={`Switch to ${nextMode} mode`}
        >
          <Icon name={mode === "dark" ? "sun" : "moon"} />
          <span className="shell-rail-foot-label">
            {nextMode === "dark" ? "Dark mode" : "Light mode"}
          </span>
        </Button>
        <Button variant="ghost" className="shell-rail-foot-row" onClick={onSignOut}>
          <Icon name="log-out" />
          <span className="shell-rail-foot-label">Sign out</span>
        </Button>
      </nav>
    </div>
  );
}

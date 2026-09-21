import { Link } from "@tanstack/react-router";
import { Button, CountBadge, Icon, Input, Menu } from "@porkbot/ui";
import type { RosterEntry } from "../roster.ts";
import { RosterRow } from "./roster-row.tsx";
import { modeLabel, modes } from "./mode.ts";
import type { Mode } from "./mode.ts";

/**
 * The rail: the roster and the single trips that used to be top-bar links
 * (slice 13.4; design record, Shell anatomy). One component serves the wide
 * rail and the narrow switcher sheet, so the roster cannot drift between the
 * two; the sheet passes `onNavigate` so a chosen bot closes it.
 *
 * Since slice 13.6 the rail reads the same roster rows the home screen does —
 * identity, name, role, the state chip and the latest activity — so a bot
 * looks the same wherever it is listed.
 *
 * Since slice 13.13 the footer's mode control is the explicit three-way choice
 * — System, Light, Dark — rather than a two-way toggle, so System is a
 * selection the operator can make and see rather than a state that only exists
 * before the first click. The menu's label is the current choice.
 */

export interface RailProps {
  readonly entries: readonly RosterEntry[];
  readonly pendingCount: number;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly mode: Mode;
  readonly onMode: (mode: Mode) => void;
  readonly onSignOut: () => void;
  readonly rosterFailed: boolean;
  readonly onRetryRoster?: (() => void) | undefined;
  /** Closes the switcher sheet after a navigation; absent in the wide rail. */
  readonly onNavigate?: (() => void) | undefined;
}

export function Rail({
  entries,
  pendingCount,
  query,
  onQuery,
  mode,
  onMode,
  onSignOut,
  rosterFailed,
  onRetryRoster,
  onNavigate,
}: RailProps) {
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? entries
      : entries.filter((entry) =>
          `${entry.bot.name} ${entry.bot.title}`.toLowerCase().includes(needle),
        );

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
        {visible.map((entry) => (
          <RosterRow key={entry.bot.id} entry={entry} size="rail" onNavigate={onNavigate} />
        ))}
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
            {entries.length === 0 ? "No bots yet." : "No bots match."}
          </p>
        ) : null}
        {!rosterFailed && entries.length === 0 ? (
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
        <Menu
          className="shell-rail-foot-mode"
          variant="ghost"
          label={`Mode: ${modeLabel(mode)}`}
          items={modes.map((candidate) => ({
            id: candidate,
            label: modeLabel(candidate),
            onSelect: () => {
              onMode(candidate);
            },
          }))}
        />
        <Button variant="ghost" className="shell-rail-foot-row" onClick={onSignOut}>
          <Icon name="log-out" />
          <span className="shell-rail-foot-label">Sign out</span>
        </Button>
      </nav>
    </div>
  );
}

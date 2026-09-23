import { Link } from "@tanstack/react-router";
import {
  Button,
  CountBadge,
  Icon,
  Input,
  Menu,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarRail,
} from "@porkbot/ui";
import type { RosterEntry } from "../roster.ts";
import { RosterRow } from "./roster-row.tsx";
import { modeLabel, modes } from "./mode.ts";
import type { Mode } from "./mode.ts";

/**
 * The rail: the roster and the single trips that used to be top-bar links
 * (slice 13.4; design record, Shell anatomy). It is the shell's left
 * `Sidebar`, so it collapses to an icon strip and takes the component's own
 * mobile sheet rather than a grid of its own.
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
    <Sidebar side="left" collapsible="icon" className="border-r border-border bg-card">
      <SidebarRail />
      <SidebarHeader>
        <span className="text-title">PorkBot</span>
        <div className="flex items-center gap-2 px-2 text-muted-foreground">
          <Icon name="search" aria-hidden="true" />
          <Input
            type="search"
            placeholder="Search bots"
            aria-label="Search bots"
            value={query}
            onChange={(event) => {
              onQuery(event.target.value);
            }}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Bots" className="flex flex-col gap-1">
              {visible.map((entry) => (
                <RosterRow key={entry.bot.id} entry={entry} size="rail" onNavigate={onNavigate} />
              ))}
              {rosterFailed ? (
                <>
                  <p className="text-body text-muted-foreground" data-rail-empty>
                    The bot list could not be loaded.
                  </p>
                  <Button variant="ghost" onClick={onRetryRoster}>
                    Try again
                  </Button>
                </>
              ) : null}
              {!rosterFailed && visible.length === 0 ? (
                <p className="text-body text-muted-foreground" data-rail-empty>
                  {entries.length === 0 ? "No bots yet." : "No bots match."}
                </p>
              ) : null}
              {!rosterFailed && entries.length === 0 ? (
                <Link
                  to="/bots/new"
                  onClick={onNavigate}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-body hover:bg-accent"
                >
                  <Icon name="plus" aria-hidden="true" />
                  New bot
                </Link>
              ) : null}
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <nav aria-label="Workspace" className="flex flex-col gap-1">
          <Link
            to="/approvals"
            onClick={onNavigate}
            aria-label={
              pendingCount > 0 ? `Approvals, ${String(pendingCount)} waiting` : "Approvals"
            }
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-body hover:bg-accent"
          >
            <Icon name="alert" aria-hidden="true" />
            <span>Approvals</span>
            {pendingCount > 0 ? <CountBadge count={pendingCount} /> : null}
          </Link>
          <Link
            to="/settings"
            onClick={onNavigate}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-body hover:bg-accent"
          >
            <Icon name="settings" aria-hidden="true" />
            <span>Settings</span>
          </Link>
          <Menu
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
          <Button variant="ghost" onClick={onSignOut}>
            <Icon name="log-out" aria-hidden="true" />
            <span>Sign out</span>
          </Button>
        </nav>
      </SidebarFooter>
    </Sidebar>
  );
}

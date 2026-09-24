import { Link, useRouterState } from "@tanstack/react-router";
import type { Approval } from "@porkbot/contracts";
import {
  BotAvatar,
  Button,
  CountBadge,
  Icon,
  IconButton,
  Input,
  Menu,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarProvider,
  SidebarRail,
  StateChip,
  useSidebar,
} from "@porkbot/ui";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { findRosterBot } from "../roster.ts";
import type { Roster, RosterEntry } from "../roster.ts";
import { stateFromPending } from "./bot-state.ts";
import { ShellHeaderProvider } from "./header-state.tsx";
import type { ShellHeaderState } from "./header-state.tsx";
import { applyMode, currentChoice, modeLabel, modes } from "./mode.ts";
import type { Mode } from "./mode.ts";
import { ModeProvider } from "./mode-context.tsx";
import { RosterRow } from "./roster-row.tsx";

/**
 * The workspace: the rail, the content pane and the inspector (slice 13.4;
 * design record, Shell anatomy). It is the shell every signed-in route renders
 * inside; the route contributes only its content.
 *
 * The rail and the inspector are two `Sidebar`s under two `SidebarProvider`s,
 * each with its own storage key, so collapsing one cannot collapse the other
 * and each takes the component's own mobile sheet below its breakpoint. The
 * selected bot is read from the URL, so the rail's active row, the header and
 * the inspector cannot disagree with the address bar.
 */

export interface WorkspaceProps {
  readonly roster: Roster;
  readonly pendingApprovals: readonly Approval[];
  /** True when the roster read failed; the rail says so instead of lying empty. */
  readonly rosterFailed?: boolean | undefined;
  readonly onRetryRoster?: (() => void) | undefined;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}

/** The rail's controls, published from its own provider for the header. */
const RailControls = createContext<{
  readonly toggle: () => void;
  readonly closeMobile: () => void;
}>({ toggle: () => undefined, closeMobile: () => undefined });
/** The inspector's toggle and visibility, published the same way. */
const InspectorToggle = createContext<{
  readonly toggle: () => void;
  readonly visible: boolean;
  readonly closeMobile: () => void;
}>({
  toggle: () => undefined,
  visible: true,
  closeMobile: () => undefined,
});

function PublishRailControls({ children }: Readonly<{ children: ReactNode }>) {
  const { toggleSidebar, setOpenMobile } = useSidebar();
  const value = useMemo(
    () => ({
      toggle: toggleSidebar,
      closeMobile: () => {
        setOpenMobile(false);
      },
    }),
    [setOpenMobile, toggleSidebar],
  );
  return <RailControls.Provider value={value}>{children}</RailControls.Provider>;
}

function PublishInspectorToggle({ children }: Readonly<{ children: ReactNode }>) {
  const { toggleSidebar, state, openMobile, isMobile, setOpenMobile } = useSidebar();
  const value = useMemo(
    () => ({
      toggle: toggleSidebar,
      visible: isMobile ? openMobile : state === "expanded",
      closeMobile: () => {
        setOpenMobile(false);
      },
    }),
    [isMobile, openMobile, setOpenMobile, state, toggleSidebar],
  );
  return <InspectorToggle.Provider value={value}>{children}</InspectorToggle.Provider>;
}

/** The deepest route param named `botId`, so every bot-scoped route selects its bot. */
function botIdFromMatches(matches: readonly { readonly params: unknown }[]): string | null {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const params = matches[index]?.params as Record<string, unknown> | undefined;
    const botId = params?.["botId"];

    if (typeof botId === "string") {
      return botId;
    }
  }

  return null;
}

export function Workspace({
  roster,
  pendingApprovals,
  rosterFailed,
  onRetryRoster,
  onSignOut,
  children,
}: WorkspaceProps) {
  const selectedBotId = useRouterState({ select: (state) => botIdFromMatches(state.matches) });
  const [query, setQuery] = useState("");
  const [reported, setReported] = useState<ShellHeaderState | null>(null);
  const [mode, setMode] = useState<Mode>(() => currentChoice());

  const pendingByBot = useMemo(() => {
    const counts = new Map<string, number>();
    for (const approval of pendingApprovals) {
      counts.set(approval.botId, (counts.get(approval.botId) ?? 0) + 1);
    }
    return counts;
  }, [pendingApprovals]);
  const selected = findRosterBot(roster, selectedBotId);
  const pendingForBot = selected === null ? 0 : (pendingByBot.get(selected.id) ?? 0);
  const state = stateFromPending(pendingForBot) ?? reported?.state ?? null;

  // The selected bot's row shows the live run its route reported, so the rail
  // and the header carry one word for one bot; every other row keeps the
  // state the roster read.
  const entries = useMemo(() => {
    if (state === null || selectedBotId === null) {
      return roster.active;
    }
    return roster.active.map((entry: RosterEntry) =>
      entry.bot.id === selectedBotId
        ? {
            ...entry,
            state,
            waiting: pendingForBot,
          }
        : entry,
    );
  }, [pendingForBot, roster.active, selectedBotId, state]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? entries
      : entries.filter((entry) =>
          `${entry.bot.name} ${entry.bot.title}`.toLowerCase().includes(needle),
        );
  }, [entries, query]);

  const chooseMode = useCallback((next: Mode) => {
    setMode(next);
    applyMode(document.documentElement, globalThis.localStorage, next);
  }, []);
  const modeValue = useMemo(() => ({ mode, setMode: chooseMode }), [mode, chooseMode]);

  function RailSlot(): ReactNode {
    const { closeMobile } = useContext(RailControls);
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
                setQuery(event.target.value);
              }}
            />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <nav aria-label="Bots" className="flex flex-col gap-1">
                {visibleEntries.map((entry) => (
                  <RosterRow
                    key={entry.bot.id}
                    entry={entry}
                    size="rail"
                    onNavigate={closeMobile}
                  />
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
                {!rosterFailed && visibleEntries.length === 0 ? (
                  <p className="text-body text-muted-foreground" data-rail-empty>
                    {entries.length === 0 ? "No bots yet." : "No bots match."}
                  </p>
                ) : null}
                {!rosterFailed && entries.length === 0 ? (
                  <Link
                    to="/bots/new"
                    onClick={closeMobile}
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
              onClick={closeMobile}
              aria-label={
                pendingApprovals.length > 0
                  ? `Approvals, ${String(pendingApprovals.length)} waiting`
                  : "Approvals"
              }
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-body hover:bg-accent"
            >
              <Icon name="alert" aria-hidden="true" />
              <span>Approvals</span>
              {pendingApprovals.length > 0 ? <CountBadge count={pendingApprovals.length} /> : null}
            </Link>
            <Link
              to="/settings"
              onClick={closeMobile}
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
                  chooseMode(candidate);
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

  function InspectorSlot(): ReactNode {
    const { closeMobile } = useContext(InspectorToggle);
    if (selected === null) {
      return null;
    }

    const meta = [selected.title, selected.computerProvider, selected.model].filter(
      (part): part is string => part !== null && part !== "",
    );
    const selectedPendingApprovals = pendingApprovals.filter(
      (approval) => approval.botId === selected.id,
    );
    return (
      <Sidebar side="right" collapsible="offcanvas" className="border-l border-border bg-card">
        <SidebarRail />
        <SidebarHeader>
          <div className="flex items-center gap-2">
            <BotAvatar id={selected.id} name={selected.name} color={selected.color} size={32} />
            <span className="flex min-w-0 flex-col">
              <span className="text-heading text-foreground">{selected.name}</span>
              <span className="text-meta text-muted-foreground">
                {meta.length === 0 ? "Bot" : meta.join(" · ")}
              </span>
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>State</SidebarGroupLabel>
            <SidebarGroupContent>
              {state === null ? (
                <p className="text-body text-muted-foreground">No state to show yet.</p>
              ) : (
                <StateChip
                  state={state}
                  count={state === "waiting" ? selectedPendingApprovals.length : undefined}
                />
              )}
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Pending approvals</SidebarGroupLabel>
            <SidebarGroupContent>
              {selectedPendingApprovals.length === 0 ? (
                <p className="text-body text-muted-foreground">Nothing waiting.</p>
              ) : (
                <>
                  <p className="text-body">
                    {selectedPendingApprovals.length === 1
                      ? "1 action is waiting for you."
                      : `${String(selectedPendingApprovals.length)} actions are waiting for you.`}
                  </p>
                  <Link
                    to="/approvals"
                    onClick={closeMobile}
                    className="text-body text-primary hover:underline"
                  >
                    Review approvals
                  </Link>
                </>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Screens</SidebarGroupLabel>
            <SidebarGroupContent>
              <nav aria-label={`${selected.name} screens`} className="flex flex-col gap-1">
                <Link
                  to="/bots/$botId/computer"
                  params={{ botId: selected.id }}
                  onClick={closeMobile}
                  className="text-body text-primary hover:underline"
                >
                  Computer
                </Link>
                <Link
                  to="/bots/$botId/memory"
                  params={{ botId: selected.id }}
                  onClick={closeMobile}
                  className="text-body text-primary hover:underline"
                >
                  Memory
                </Link>
                <Link
                  to="/bots/$botId/usage"
                  params={{ botId: selected.id }}
                  onClick={closeMobile}
                  className="text-body text-primary hover:underline"
                >
                  Usage
                </Link>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    );
  }

  const rail = <RailSlot />;
  const inspector = <InspectorSlot />;

  return (
    <ShellHeaderProvider report={setReported}>
      <ModeProvider value={modeValue}>
        <SidebarProvider storageKey="rail">
          <PublishRailControls>
            <div className="flex h-dvh overflow-hidden">
              {rail}
              <SidebarProvider storageKey="inspector">
                <PublishInspectorToggle>
                  <div className="flex min-w-0 flex-1">
                    <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
                      <WorkspaceHeader
                        selected={selected}
                        state={state}
                        pendingForBot={pendingForBot}
                      />
                      <div className="flex min-h-0 flex-1 flex-col" data-shell-pane>
                        {children}
                      </div>
                    </main>
                    {inspector}
                  </div>
                </PublishInspectorToggle>
              </SidebarProvider>
            </div>
          </PublishRailControls>
        </SidebarProvider>
      </ModeProvider>
    </ShellHeaderProvider>
  );
}

function WorkspaceHeader({
  selected,
  state,
  pendingForBot,
}: {
  readonly selected: ReturnType<typeof findRosterBot>;
  readonly state: ReturnType<typeof stateFromPending> | ShellHeaderState["state"] | null;
  readonly pendingForBot: number;
}) {
  const { toggle: toggleRail } = useContext(RailControls);
  const inspectorToggle = useContext(InspectorToggle);
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <IconButton label="Switch bot" icon="menu" onClick={toggleRail} />
      {selected === null ? (
        <span className="text-title">PorkBot</span>
      ) : (
        <>
          <BotAvatar id={selected.id} name={selected.name} color={selected.color} size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="text-heading text-foreground">{selected.name}</span>
            <span className="text-meta text-muted-foreground">
              {selected.title === "" ? "Bot" : selected.title}
            </span>
          </span>
          {state === null ? null : (
            <StateChip
              state={state}
              count={state === "waiting" && pendingForBot > 0 ? pendingForBot : undefined}
            />
          )}
          <span className="ml-auto">
            <IconButton
              label={inspectorToggle.visible ? "Hide bot context" : "Show bot context"}
              icon="panel-left"
              aria-expanded={inspectorToggle.visible}
              onClick={inspectorToggle.toggle}
            />
          </span>
        </>
      )}
    </header>
  );
}

import { useRouterState } from "@tanstack/react-router";
import type { Approval } from "@porkbot/contracts";
import { BotAvatar, IconButton, SidebarProvider, StateChip, useSidebar } from "@porkbot/ui";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { findRosterBot } from "../roster.ts";
import type { Roster, RosterEntry } from "../roster.ts";
import { stateFromPending } from "./bot-state.ts";
import { ShellHeaderProvider } from "./header-state.tsx";
import type { ShellHeaderState } from "./header-state.tsx";
import { Inspector } from "./inspector.tsx";
import { applyMode, currentChoice } from "./mode.ts";
import type { Mode } from "./mode.ts";
import { ModeProvider } from "./mode-context.tsx";
import { Rail } from "./rail.tsx";

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

  const chooseMode = useCallback((next: Mode) => {
    setMode(next);
    applyMode(document.documentElement, globalThis.localStorage, next);
  }, []);
  const modeValue = useMemo(() => ({ mode, setMode: chooseMode }), [mode, chooseMode]);

  function RailSlot(): ReactNode {
    const { closeMobile } = useContext(RailControls);
    return (
      <Rail
        entries={entries}
        pendingCount={pendingApprovals.length}
        query={query}
        onQuery={setQuery}
        mode={mode}
        onMode={chooseMode}
        onSignOut={onSignOut}
        rosterFailed={rosterFailed ?? false}
        onRetryRoster={onRetryRoster}
        onNavigate={closeMobile}
      />
    );
  }

  function InspectorSlot(): ReactNode {
    const { closeMobile } = useContext(InspectorToggle);
    return selected === null ? null : (
      <Inspector
        bot={selected}
        state={state}
        pendingApprovals={pendingApprovals.filter((approval) => approval.botId === selected.id)}
        onNavigate={closeMobile}
      />
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

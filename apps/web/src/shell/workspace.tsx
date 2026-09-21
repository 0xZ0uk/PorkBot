import { useRouterState } from "@tanstack/react-router";
import type { Approval, Bot } from "@porkbot/contracts";
import { BotAvatar, IconButton, Sheet, StateChip } from "@porkbot/ui";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { stateFromPending } from "./bot-state.ts";
import { ShellHeaderProvider } from "./header-state.tsx";
import type { ShellHeaderState } from "./header-state.tsx";
import { defaultStorage, readInspectorOpen, writeInspectorOpen } from "./inspector-preference.ts";
import { Inspector } from "./inspector.tsx";
import { applyMode, currentMode, toggled } from "./mode.ts";
import type { Mode } from "./mode.ts";
import { Rail } from "./rail.tsx";
import { useMediaQuery } from "./use-media-query.ts";

/**
 * The workspace: the rail, the content pane and the inspector, with one pane
 * at a time and a switcher sheet below 64rem (slice 13.4; design record, Shell
 * anatomy). It is the shell every signed-in route renders inside; the route
 * contributes only its content.
 *
 * The selected bot is read from the URL, so the rail's active row, the header
 * and the inspector cannot disagree with the address bar, and the inspector's
 * collapsed state is a stored preference rather than route state, so it
 * survives navigation.
 */

export interface WorkspaceProps {
  readonly bots: readonly Bot[];
  readonly pendingApprovals: readonly Approval[];
  /** True when the roster read failed; the rail says so instead of lying empty. */
  readonly rosterFailed?: boolean | undefined;
  readonly onRetryRoster?: (() => void) | undefined;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}

/** The narrow layout's breakpoint: rail plus inspector plus a readable thread. */
const narrowQuery = "(max-width: 63.99rem)";

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
  bots,
  pendingApprovals,
  rosterFailed,
  onRetryRoster,
  onSignOut,
  children,
}: WorkspaceProps) {
  const selectedBotId = useRouterState({ select: (state) => botIdFromMatches(state.matches) });
  const narrow = useMediaQuery(narrowQuery, false);
  const [query, setQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(() => readInspectorOpen(defaultStorage()));
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false);
  const [reported, setReported] = useState<ShellHeaderState | null>(null);
  const [mode, setMode] = useState<Mode>(() => currentMode());

  const pendingByBot = useMemo(() => {
    const counts = new Map<string, number>();

    for (const approval of pendingApprovals) {
      counts.set(approval.botId, (counts.get(approval.botId) ?? 0) + 1);
    }

    return counts;
  }, [pendingApprovals]);

  const selected = bots.find((bot) => bot.id === selectedBotId) ?? null;
  const pendingForBot = selected === null ? 0 : (pendingByBot.get(selected.id) ?? 0);
  const state = stateFromPending(pendingForBot) ?? reported?.state ?? null;
  const inspectorVisible = narrow ? inspectorSheetOpen : inspectorOpen;

  function toggleInspector(): void {
    if (narrow) {
      setInspectorSheetOpen((open) => !open);

      return;
    }

    const next = !inspectorOpen;
    setInspectorOpen(next);
    writeInspectorOpen(defaultStorage(), next);
  }

  function toggleMode(): void {
    const next = toggled(mode);

    applyMode(document.documentElement, defaultStorage(), next);
    setMode(next);
  }

  const rail = (
    <Rail
      bots={bots}
      pendingByBot={pendingByBot}
      pendingCount={pendingApprovals.length}
      query={query}
      onQuery={setQuery}
      mode={mode}
      onToggleMode={toggleMode}
      onSignOut={onSignOut}
      rosterFailed={rosterFailed ?? false}
      onRetryRoster={onRetryRoster}
      onNavigate={() => {
        setSwitcherOpen(false);
      }}
    />
  );

  const inspector =
    selected === null ? null : (
      <Inspector
        bot={selected}
        state={state}
        pendingApprovals={pendingApprovals.filter((approval) => approval.botId === selected.id)}
        onNavigate={() => {
          setInspectorSheetOpen(false);
        }}
      />
    );

  return (
    <ShellHeaderProvider report={setReported}>
      <div
        className="shell"
        data-inspector={inspectorOpen ? "open" : "closed"}
        data-layout={narrow ? "narrow" : "wide"}
      >
        {narrow ? null : (
          <aside className="shell-rail" aria-label="Workspace">
            {rail}
          </aside>
        )}

        <main id="main" className="shell-content" tabIndex={-1}>
          <header className="shell-header">
            {narrow ? (
              <IconButton
                label="Switch bot"
                icon="menu"
                onClick={() => {
                  setSwitcherOpen(true);
                }}
              />
            ) : null}
            {selected === null ? (
              <span className="shell-header-title">PorkBot</span>
            ) : (
              <>
                <BotAvatar id={selected.id} name={selected.name} color={selected.color} size={32} />
                <span className="shell-header-body">
                  <span className="shell-header-name">{selected.name}</span>
                  <span className="shell-header-meta">
                    {selected.title === "" ? "Bot" : selected.title}
                  </span>
                </span>
                {state === null ? null : (
                  <StateChip
                    state={state}
                    count={state === "waiting" && pendingForBot > 0 ? pendingForBot : undefined}
                  />
                )}
                {/* The wrapper is the flex item: the icon button renders inside
                    the tooltip's own span, which an auto margin on the button
                    cannot push to the header's end. */}
                <span className="shell-header-toggle">
                  <IconButton
                    label={inspectorVisible ? "Hide bot context" : "Show bot context"}
                    icon="panel-left"
                    aria-expanded={inspectorVisible}
                    onClick={toggleInspector}
                  />
                </span>
              </>
            )}
          </header>
          <div className="shell-pane">{children}</div>
        </main>

        {narrow || selected === null || !inspectorOpen ? null : (
          <aside className="shell-inspector" aria-label={`${selected.name} context`}>
            {inspector}
          </aside>
        )}

        {narrow && switcherOpen ? (
          <Sheet
            open
            title="Bots"
            onClose={() => {
              setSwitcherOpen(false);
            }}
          >
            {rail}
          </Sheet>
        ) : null}

        {narrow && inspectorSheetOpen && selected !== null ? (
          <Sheet
            open
            title={selected.name}
            onClose={() => {
              setInspectorSheetOpen(false);
            }}
          >
            {inspector}
          </Sheet>
        ) : null}
      </div>
    </ShellHeaderProvider>
  );
}

/**
 * The tray's content (slice 11.6).
 *
 * The tray is the app's always-present surface: it says whether the window is
 * up, how many runs the app has seen in flight, and it carries the two actions
 * that are not in the web UI — change the server, check for updates — plus
 * quit. The template is data so the labels are asserted in the unit suite; the
 * Electron glue only maps each id to its handler.
 */

export type TrayMenuItem =
  | { readonly type: "separator" }
  | {
      readonly type: "action";
      readonly id: "open" | "server" | "updates" | "quit";
      readonly label: string;
      readonly enabled: boolean;
    };

export interface TrayState {
  readonly windowVisible: boolean;
  readonly activeRuns: number;
}

export function trayTooltip(state: TrayState): string {
  if (state.activeRuns > 0) {
    return `PorkBot — ${state.activeRuns} run${state.activeRuns === 1 ? "" : "s"} in progress`;
  }

  return "PorkBot";
}

export function trayMenuTemplate(state: TrayState): readonly TrayMenuItem[] {
  return [
    {
      type: "action",
      id: "open",
      label: state.windowVisible ? "Hide PorkBot" : "Show PorkBot",
      enabled: true,
    },
    { type: "separator" },
    { type: "action", id: "server", label: "Change server…", enabled: true },
    { type: "action", id: "updates", label: "Check for updates…", enabled: true },
    { type: "separator" },
    { type: "action", id: "quit", label: "Quit PorkBot", enabled: true },
  ];
}

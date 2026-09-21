import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";
import type { StateChipState } from "@porkbot/ui";

/**
 * How a content route tells the shell's header what it knows (slice 13.4).
 *
 * The header belongs to the shell, but the run state belongs to the screen
 * inside it: the thread route subscribes to a run's liveness and the shell
 * cannot. The route reports the state it is rendering; the shell prefers it
 * over what it can derive, and the report is cleared when the route unmounts
 * so a stale state never follows a navigation.
 */

export interface ShellHeaderState {
  readonly state: StateChipState;
}

type Report = (state: ShellHeaderState | null) => void;

const ShellHeaderContext = createContext<Report>(() => undefined);

export function ShellHeaderProvider({
  report,
  children,
}: Readonly<{ report: Report; children: ReactNode }>) {
  return <ShellHeaderContext.Provider value={report}>{children}</ShellHeaderContext.Provider>;
}

/** Reports while mounted, and clears the report when the route leaves. */
export function useShellHeaderState(state: StateChipState | null): void {
  const report = useContext(ShellHeaderContext);

  useEffect(() => {
    if (state === null) {
      report(null);

      return;
    }

    report({ state });

    return () => {
      report(null);
    };
  }, [report, state]);
}

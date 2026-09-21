import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Mode } from "./mode.ts";

/**
 * The mode choice, shared by the shell chrome that writes it (slice 13.13).
 *
 * The choice's state and the one place it is applied live in `Workspace`; the
 * rail footer and the settings surface render controls into the same choice
 * through this context, so the two can never disagree about what is selected
 * or write different keys.
 */

export interface ModeValue {
  /** The operator's choice: System, Light or Dark. */
  readonly mode: Mode;
  /** Applies and stores the choice; the shell owns the document write. */
  readonly setMode: (mode: Mode) => void;
}

const ModeContext = createContext<ModeValue>({
  mode: "system",
  setMode: () => undefined,
});

export function ModeProvider({
  value,
  children,
}: Readonly<{ value: ModeValue; children: ReactNode }>) {
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeValue {
  return useContext(ModeContext);
}

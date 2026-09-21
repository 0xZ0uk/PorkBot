import { themeStorageKey } from "@porkbot/tokens";

/**
 * The shell's mode control (design record, Mode policy). This is the interim
 * two-way toggle the rail footer carries: it writes the same key the pre-paint
 * bootstrap reads, so the choice survives a reload with no flash. Slice 13.13
 * replaces it with the explicit System, Light, Dark control.
 */

export type Mode = "light" | "dark";

type Writable = Pick<Storage, "setItem">;

interface ThemeRoot {
  readonly dataset: { theme?: string | undefined };
}

function prefersDark(): boolean {
  const matchMedia = (
    globalThis as { matchMedia?: (query: string) => { readonly matches: boolean } }
  ).matchMedia;

  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The mode in force: an explicit `data-theme` wins, otherwise the system
 * preference, matching what `themeStyleSheet` already painted.
 */
export function readMode(root: ThemeRoot, systemPrefersDark: boolean): Mode {
  const declared = root.dataset.theme;

  if (declared === "light" || declared === "dark") {
    return declared;
  }

  return systemPrefersDark ? "dark" : "light";
}

/** The mode the document is showing now, or the light default with no document. */
export function currentMode(): Mode {
  const root = (globalThis as { document?: { documentElement: ThemeRoot } }).document
    ?.documentElement;

  return root === undefined ? "light" : readMode(root, prefersDark());
}

export function toggled(mode: Mode): Mode {
  return mode === "dark" ? "light" : "dark";
}

/** Applies the choice to the document and stores it for the next first paint. */
export function applyMode(root: ThemeRoot, storage: Writable | undefined, mode: Mode): void {
  root.dataset.theme = mode;

  try {
    storage?.setItem(themeStorageKey, mode);
  } catch {
    // A blocked write costs persistence, not the choice.
  }
}

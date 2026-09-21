import { themeStorageKey } from "@porkbot/tokens";

/**
 * The shell's mode control (design record, Mode policy; slice 13.13). The
 * choice is explicit — System, Light or Dark — and it lives in the rail footer
 * and in the settings surface, both writing the same stored key the pre-paint
 * bootstrap reads. System is a real choice, not an absent one: it clears
 * `data-theme` so the stylesheet's media query decides, and the bootstrap
 * leaves it to the same media query on the next first paint.
 */

/** What the operator chose; `system` means the OS preference decides. */
export type Mode = "system" | "light" | "dark";

/** What the document paints once the choice is resolved. */
export type ResolvedMode = "light" | "dark";

type Writable = Pick<Storage, "setItem">;

interface ThemeRoot {
  readonly dataset: { theme?: string | undefined };
}

/** The three choices, in the order the controls render them. */
export const modes: readonly Mode[] = ["system", "light", "dark"];

export function modeLabel(mode: Mode): string {
  switch (mode) {
    case "system":
      return "System";
    case "light":
      return "Light";
    case "dark":
      return "Dark";
  }
}

export function resolveMode(mode: Mode, systemPrefersDark: boolean): ResolvedMode {
  if (mode === "system") {
    return systemPrefersDark ? "dark" : "light";
  }

  return mode;
}

function prefersDark(): boolean {
  const matchMedia = (
    globalThis as { matchMedia?: (query: string) => { readonly matches: boolean } }
  ).matchMedia;

  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * The stored choice: an explicit `data-theme` is the choice it paints, and its
 * absence means System. Anything else in the attribute is not a choice this
 * module wrote, so it is read as System rather than guessed at.
 */
export function readChoice(root: ThemeRoot): Mode {
  const declared = root.dataset.theme;

  return declared === "light" || declared === "dark" ? declared : "system";
}

/** The choice the document is showing now, or System with no document. */
export function currentChoice(): Mode {
  const root = (globalThis as { document?: { documentElement: ThemeRoot } }).document
    ?.documentElement;

  return root === undefined ? "system" : readChoice(root);
}

/** The mode in force: the choice resolved against the system preference. */
export function readMode(root: ThemeRoot, systemPrefersDark: boolean): ResolvedMode {
  return resolveMode(readChoice(root), systemPrefersDark);
}

/** The mode the document is showing now, or the light default with no document. */
export function currentMode(): ResolvedMode {
  return resolveMode(currentChoice(), prefersDark());
}

/**
 * Applies the choice to the document and stores it for the next first paint.
 * Choosing System removes `data-theme` so the media query wins again; the key
 * is still written, so the choice survives a reload as the choice it was.
 */
export function applyMode(root: ThemeRoot, storage: Writable | undefined, mode: Mode): void {
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }

  try {
    storage?.setItem(themeStorageKey, mode);
  } catch {
    // A blocked write costs persistence, not the choice.
  }
}

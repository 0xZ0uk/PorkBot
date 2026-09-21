/**
 * Whether the inspector is open (slice 13.4). It is a device preference, not
 * route state: an operator who closed the inspector on a 1280 screen should
 * not have it reopen on every navigation, so the shell stores the choice the
 * way the theme stores its own and re-reads it on the next mount.
 */

export const inspectorPreferenceKey = "porkbot.inspector";

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;

/** The browser's storage, or `undefined` where there is none or it is blocked. */
export function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Open unless the operator closed it; a blocked read keeps the default. */
export function readInspectorOpen(storage: Readable | undefined): boolean {
  if (storage === undefined) {
    return true;
  }

  try {
    return storage.getItem(inspectorPreferenceKey) !== "closed";
  } catch {
    return true;
  }
}

/** A write that fails must not break the shell; the choice simply does not persist. */
export function writeInspectorOpen(storage: Writable | undefined, open: boolean): void {
  if (storage === undefined) {
    return;
  }

  try {
    storage.setItem(inspectorPreferenceKey, open ? "open" : "closed");
  } catch {
    // Deliberately ignored: the shell still collapses for this session.
  }
}

/**
 * The desktop's on-disk settings (slice 11.6).
 *
 * One file under Electron's userData directory holds the server address. It is
 * parsed defensively: a missing, unreadable or corrupt file reads as "no server
 * yet" and the app opens the setup page instead of failing to start, and a
 * stored address is re-validated on read so a hand-edited file cannot smuggle a
 * scheme the setup page would have refused.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write cannot
 * leave a half-written settings file behind.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseServerOrigin } from "./server-origin.ts";

export interface DesktopSettings {
  /** The operator's deployment, or `null` before the setup page ran. */
  readonly serverOrigin: string | null;
}

export const emptySettings: DesktopSettings = Object.freeze({ serverOrigin: null });

export function settingsFilePath(userDataDirectory: string): string {
  return path.join(userDataDirectory, "desktop-settings.json");
}

/** Reads stored settings; anything unusable reads as unconfigured. */
export function parseSettings(raw: string): DesktopSettings {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySettings;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return emptySettings;
  }

  const stored = (parsed as { serverOrigin?: unknown }).serverOrigin;

  if (typeof stored !== "string") {
    return emptySettings;
  }

  const origin = parseServerOrigin(stored);

  return origin.ok ? { serverOrigin: origin.origin } : emptySettings;
}

export async function readSettings(file: string): Promise<DesktopSettings> {
  try {
    return parseSettings(await readFile(file, "utf8"));
  } catch {
    return emptySettings;
  }
}

export async function writeSettings(file: string, settings: DesktopSettings): Promise<void> {
  const temporary = `${file}.tmp`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

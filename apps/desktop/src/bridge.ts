/**
 * The preload bridge's wire (slice 11.6).
 *
 * The renderer is sandboxed, so the only way it can tell the desktop what it
 * observed is the preload's `contextBridge` surface. The channel name and the
 * payload type live here for the main process and the tests; `preload.cts`
 * cannot import this module — a sandboxed preload's `require` is a polyfill
 * that resolves no sibling file — so it writes the same literal, and
 * `hardening.test.ts` reads both and fails when they drift.
 */

import type { RunEvent } from "@porkbot/core";

/** The renderer -> main channel carrying a run's lifecycle frame. */
export const runEventChannel = "porkbot:run-event";

/** What the preload exposes as `globalThis.porkbot`. */
export interface DesktopBridge {
  /** Forwards one run lifecycle frame; a no-op when no desktop hosts the page. */
  forwardRunEvent(event: RunEvent): void;
}

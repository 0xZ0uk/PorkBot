import type { RunEvent } from "@porkbot/core";

/**
 * The desktop wrapper's bridge (slice 11.6).
 *
 * When the packaged build runs inside the Electron shell, the preload injects
 * `globalThis.porkbot`; in a browser the property is absent and every call here
 * is a no-op, so the web build is one artifact for both hosts. The console
 * hands each accepted frame to `forwardRunEvent`, which forwards the run's own
 * lifecycle frames — `run.started` and the terminal ones — across the bridge.
 * Token deltas stay on this side: the desktop tracks which runs are in flight
 * and shows a native notification when one settles, and it needs no other
 * frame to do either.
 *
 * The bridge surface is validated rather than trusted: the page could run
 * inside a shell that exposes something else under the same name, and a
 * malformed bridge must not break the console.
 */

export interface DesktopBridge {
  forwardRunEvent(event: RunEvent): void;
}

function desktopBridge(): DesktopBridge | undefined {
  const candidate = (globalThis as { porkbot?: unknown }).porkbot;

  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }

  const forward = (candidate as { forwardRunEvent?: unknown }).forwardRunEvent;

  return typeof forward === "function" ? (candidate as DesktopBridge) : undefined;
}

/** True for a run lifecycle frame; a token delta is not one. */
export function isRunLifecycleFrame(event: RunEvent): boolean {
  return event.type.startsWith("run.");
}

/** Hands a lifecycle frame to the desktop, when a desktop is hosting the page. */
export function forwardRunEvent(event: RunEvent): void {
  if (!isRunLifecycleFrame(event)) {
    return;
  }

  desktopBridge()?.forwardRunEvent(event);
}

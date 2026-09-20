/**
 * Where the packaged web build lives (slice 11.6).
 *
 * In a packaged app the SPA is an extra resource beside the app bundle, so
 * `apps/web/dist/client` travels into `Contents/Resources/client` (or the Linux
 * and Windows equivalent). In development the checkout keeps the build where
 * `pnpm build` wrote it, next to the desktop package. The two shapes are one
 * function so a dev run and a packaged run load the same directory the web
 * image serves rather than a copy.
 */

import path from "node:path";

export interface ClientRootOptions {
  readonly isPackaged: boolean;
  /** `process.resourcesPath` in a packaged app; unused in development. */
  readonly resourcesPath: string;
  /** The desktop package directory, e.g. `apps/desktop`. */
  readonly appDirectory: string;
}

export function resolveClientRoot(options: ClientRootOptions): string {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, "client");
  }

  return path.resolve(options.appDirectory, "..", "web", "dist", "client");
}

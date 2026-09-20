/**
 * The desktop hardening contract (slice 11.6).
 *
 * The issue asks for `contextIsolation` on, sandbox on, `nodeIntegration` off
 * and a content security policy, and for those settings to be asserted rather
 * than intended. So the window flags and the policy live in one table here,
 * `main.ts` builds every window from `hardenWebPreferences`, and
 * `hardening.test.ts` walks the shipped tree to fail a `BrowserWindow` that
 * passes anything else.
 *
 * The content security policy is nonce-based rather than hash-based. The
 * prerendered SPA shell carries inline scripts (scroll restoration and the
 * hydration stream) and the inlined token stylesheet, and the hydration stream
 * contains bytes the HTML parser rewrites — a raw NUL becomes U+FFFD — so a
 * hash computed from the file on disk is not the hash of the script the parser
 * executes. The proxy instead stamps a fresh nonce onto every inline script and
 * style as it serves the document and names that nonce in the policy, which
 * covers exactly what the app shipped and refuses anything else the page tries
 * to run.
 */

import { randomBytes } from "node:crypto";

/** The window flags every desktop window is created with. */
export const HARDENED_WEB_PREFERENCES = Object.freeze({
  /** The renderer's world is separate from the preload's; no prototype sharing. */
  contextIsolation: true,
  /** The renderer runs in Chromium's sandbox, with no Node and no OS access. */
  sandbox: true,
  /** No `require` in the page; the preload bridge is the only channel. */
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  /** Same-origin policy stays on; the renderer is not a trusted context. */
  webSecurity: true,
  allowRunningInsecureContent: false,
  /** No experimental Chromium surface on a page that renders bot content. */
  experimentalFeatures: false,
  webviewTag: false,
  /** A dropped file must not start a navigation the user did not ask for. */
  navigateOnDragDrop: false,
  spellcheck: false,
} as const);

export type HardenedWebPreferences = typeof HARDENED_WEB_PREFERENCES;

export interface HardenedWebPreferencesOptions {
  /** Absolute path to the compiled preload script (`.cjs`). */
  readonly preload: string;
  /**
   * The stream keeps delivering while the window is hidden, so a run that
   * finishes in the background still reaches the tray and the notification.
   * It is the one non-hardening flag the shell chooses, named here so the flag
   * has an owner.
   */
  readonly backgroundThrottling: boolean;
}

/** The `webPreferences` of any window the app creates. */
export type DesktopWebPreferences = HardenedWebPreferences &
  Pick<HardenedWebPreferencesOptions, "preload" | "backgroundThrottling">;

/**
 * Builds the hardened preferences. Only the preload path and background
 * throttling are parameters; every security flag is the table's, so a caller
 * cannot pass `contextIsolation: false` because there is nowhere to pass it.
 */
export function hardenWebPreferences(
  options: HardenedWebPreferencesOptions,
): DesktopWebPreferences {
  return {
    ...HARDENED_WEB_PREFERENCES,
    preload: options.preload,
    backgroundThrottling: options.backgroundThrottling,
  };
}

/**
 * The contract violations in a candidate preferences object, by setting name.
 * An empty list means the candidate may build a window.
 */
export function hardeningViolations(preferences: Readonly<Record<string, unknown>>): string[] {
  const violations: string[] = [];

  for (const [key, required] of Object.entries(HARDENED_WEB_PREFERENCES)) {
    if (preferences[key] !== required) {
      violations.push(key);
    }
  }

  if (typeof preferences["preload"] !== "string" || preferences["preload"].length === 0) {
    violations.push("preload");
  }

  return violations;
}

/** Throws when a window's preferences are not the hardened ones. */
export function assertHardened(preferences: Readonly<Record<string, unknown>>): void {
  const violations = hardeningViolations(preferences);

  if (violations.length > 0) {
    throw new Error(
      `Refusing to open an un-hardened window: ${violations.join(", ")}. ` +
        "Every window is created through hardenWebPreferences in hardening.ts.",
    );
  }
}

const inlineScript = /<script(?![^>]*\bsrc\s*=)([^>]*)>/gi;
const inlineStyle = /<style([^>]*)>/gi;

/** A fresh, unguessable nonce for one served document. */
export function createContentSecurityNonce(): string {
  return randomBytes(16).toString("base64");
}

function withNonce(attributes: string, nonce: string): string {
  const withoutExisting = attributes.replace(/\s+nonce\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  return ` nonce="${nonce}"${withoutExisting}`;
}

/**
 * Stamps one nonce onto every inline script and style in a document. A script
 * with a `src` is left alone: `'self'` already names the app's own bundle.
 */
export function applyContentSecurityNonce(html: string, nonce: string): string {
  return html
    .replace(
      inlineScript,
      (_match, attributes: string) => `<script${withNonce(attributes, nonce)}>`,
    )
    .replace(inlineStyle, (_match, attributes: string) => `<style${withNonce(attributes, nonce)}>`);
}

/**
 * The content security policy for one served document. `connect-src 'self'`
 * covers the RPC client and the event stream because the desktop serves both
 * from its own origin through the proxy; `img-src` allows the `data:` and
 * `blob:` avatars the API can hand back.
 */
export function contentSecurityPolicyFor(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

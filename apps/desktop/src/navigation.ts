/**
 * Where the desktop window may go (slice 11.6).
 *
 * The window is an app, not a browser. It loads the packaged build from the
 * proxy's loopback origin and it must stay there: a link a bot renders or a
 * compromised page cannot navigate the renderer to a foreign origin, and an
 * `https:` link the operator clicks opens in the system browser instead, where
 * the OS's own rules apply. The decision is a pure function so the rules are
 * asserted without an Electron process, and `main.ts` wires it into
 * `will-navigate` and the window-open handler.
 */

export type NavigationRefusal = "malformed" | "foreign-origin" | "unsupported-scheme";

export type NavigationDecision =
  | { readonly action: "allow" }
  | { readonly action: "open-external"; readonly url: string }
  | { readonly action: "deny"; readonly reason: NavigationRefusal };

export interface NavigationRequest {
  /** The destination, as the renderer asked for it. */
  readonly url: string;
  /** The proxy origin the packaged build is served from. */
  readonly appOrigin: string;
  /** Whether the request came from the top frame or an embedded one. */
  readonly frame: "main" | "subframe";
}

/**
 * True for the app's own origin. `URL.origin` normalizes case and default
 * ports, so `HTTP://127.0.0.1:80` and `http://127.0.0.1` are the same place.
 */
function isAppOrigin(target: URL, appOrigin: string): boolean {
  try {
    return target.origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

export function decideNavigation(request: NavigationRequest): NavigationDecision {
  let target: URL;

  try {
    target = new URL(request.url);
  } catch {
    return { action: "deny", reason: "malformed" };
  }

  if (isAppOrigin(target, request.appOrigin)) {
    return { action: "allow" };
  }

  // A frame may not embed a foreign document at all: the app renders its own
  // build, and an iframe is a surface nothing in the product needs.
  if (request.frame === "subframe") {
    return { action: "deny", reason: "foreign-origin" };
  }

  if (target.protocol === "https:") {
    return { action: "open-external", url: target.href };
  }

  return { action: "deny", reason: "unsupported-scheme" };
}

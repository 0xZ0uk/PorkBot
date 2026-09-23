import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { themeBootstrapScript, themeStyleSheet } from "../theme.ts";
import { NotFoundScreen } from "../screens/not-found.tsx";
import type { RouterContext } from "../router.tsx";

/**
 * The document shell. It is the one place the HTML element, the theme and the
 * client bundle are wired, and it renders for the prerendered SPA shell as well
 * as for the running app, so the first paint already carries the tokens.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "PorkBot" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFoundScreen,
});

/**
 * jsdom hosts a document of its own and cannot accept an `<html>` element
 * inside a test container: the nesting warning is a symptom, and a pointer
 * press against the host body after such a render never finishes dispatching.
 * The document element is the browser's to own, so the harness gets the skip
 * link and the screen and nothing else.
 */
const hostIsJsdom = typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  if (hostIsJsdom) {
    return (
      <>
        <SkipLink />
        {children}
      </>
    );
  }
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: themeStyleSheet }} />
        {/* Applies a stored mode choice before the first paint; a system
            preference is left to the stylesheet's media query. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <SkipLink />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** The first focusable element on every screen, so a keyboard user can jump
 * past the header once the app chrome exists. */
function SkipLink() {
  return (
    <a
      className="absolute left-3 top-3 z-10 -translate-y-[calc(100%+1rem)] rounded-md border border-border bg-card px-3 py-2 text-foreground focus:translate-y-0"
      href="#main"
    >
      Skip to main content
    </a>
  );
}

import { useCallback, useSyncExternalStore } from "react";

/**
 * A media query as React state (slice 13.4). The shell uses it to choose the
 * narrow layout — one pane at a time with a switcher sheet — rather than
 * rendering both layouts and hiding one, because a sheet that is mounted but
 * `display:none` still owns a focus trap.
 *
 * The subscription is tolerant of an environment without `matchMedia` (jsdom,
 * and any prerender): the caller's fallback is then the answer, so a test that
 * does not care about width renders the wide layout without stubbing anything.
 */

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

function mediaQueryList(query: string): MediaQueryListLike | undefined {
  const matchMedia = (globalThis as { matchMedia?: (query: string) => MediaQueryListLike })
    .matchMedia;

  return typeof matchMedia === "function" ? matchMedia(query) : undefined;
}

export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query);

      if (list === undefined) {
        return () => undefined;
      }

      list.addEventListener("change", onChange);

      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => mediaQueryList(query)?.matches ?? fallback,
    [query, fallback],
  );
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

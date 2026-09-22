import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Tracks the mobile breakpoint, which decides whether a `Sidebar` collapses
 * into a sheet. Guarded for jsdom and other environments without `matchMedia`.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`);
    const update = (): void => {
      setIsMobile(query.matches);
    };

    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    return;
  }, []);

  return isMobile;
}

/** ScrollArea: the overflow container the rail, transcript and inspector share. */

import type { ReactNode } from "react";

export type ScrollAreaProps = {
  /** The accessible name for the scrollable region. */
  readonly label?: string;
  /** A CSS length; the caller's layout usually decides the height instead. */
  readonly maxHeight?: string;
  readonly className?: string;
  readonly children: ReactNode;
};

export function ScrollArea({ label, maxHeight, className, children }: ScrollAreaProps) {
  return (
    <div
      className={["pb-scroll-area", className].filter(Boolean).join(" ")}
      style={maxHeight === undefined ? undefined : { maxHeight }}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

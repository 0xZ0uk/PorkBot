/** ScrollArea: the overflow container the rail, transcript and inspector share. */
import type { ReactNode, Ref, UIEvent } from "react";
import { cn } from "./lib/utils.ts";

export type ScrollAreaProps = {
  /** The accessible name for the scrollable region. */
  readonly label?: string;
  /** A CSS length; the caller's layout usually decides the height instead. */
  readonly maxHeight?: string;
  readonly className?: string;
  /**
   * The element itself, so a caller that follows the bottom of a transcript —
   * or restores a reading position — can read and write its scroll offset.
   */
  readonly ref?: Ref<HTMLDivElement>;
  /** Every scroll of the region, for a caller that tracks the reading position. */
  readonly onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
};

export function ScrollArea({
  label,
  maxHeight,
  className,
  ref,
  onScroll,
  children,
}: ScrollAreaProps) {
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={cn(
        "min-h-0 overflow-auto overscroll-contain focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary",
        className,
      )}
      style={maxHeight === undefined ? undefined : { maxHeight }}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

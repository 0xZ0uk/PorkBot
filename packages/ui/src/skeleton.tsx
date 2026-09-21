export type SkeletonProps = {
  /** A CSS length; the default is the text line's own height. */
  readonly width?: string;
  readonly height?: string;
  /** Draws a stack of `lines` bars; one by default. */
  readonly lines?: number;
  readonly className?: string;
};

/**
 * The loading state for every data screen. It pulses with the ambient motion
 * budget and stands still under `prefers-reduced-motion` (style-sheet.test.ts
 * holds the rule).
 */
export function Skeleton({ width, height, lines = 1, className }: SkeletonProps) {
  const bar = (key: number) => (
    <span
      key={key}
      className={["pb-skeleton", className].filter(Boolean).join(" ")}
      style={{ width: width ?? "100%", height: height ?? "0.75rem" }}
      aria-hidden="true"
    />
  );

  if (lines <= 1) {
    return bar(0);
  }

  return (
    <span className={["pb-skeleton-group", className].filter(Boolean).join(" ")} aria-hidden="true">
      {Array.from({ length: lines }, (_value, index) => (
        <span
          key={index}
          className="pb-skeleton"
          style={{ width: width ?? "100%", height: height ?? "0.75rem" }}
        />
      ))}
    </span>
  );
}

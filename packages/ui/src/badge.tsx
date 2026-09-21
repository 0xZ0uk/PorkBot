import type { CSSProperties, ReactNode } from "react";

/** The badge tones the register ships; `neutral` is the default. */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "info" | "destructive";

export type BadgeProps = {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children: ReactNode;
};

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return (
    <span
      className={["pb-badge", tone !== "neutral" && `pb-badge--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

export type CountBadgeProps = {
  readonly count: number;
  readonly className?: string;
};

/** The "waiting for you" count; the chip carries the word, this carries the n. */
export function CountBadge({ count, className }: CountBadgeProps) {
  return <span className={["pb-count-badge", className].filter(Boolean).join(" ")}>{count}</span>;
}

/** The six words of the state vocabulary (design record, State vocabulary). */
export type StateChipState = "idle" | "working" | "waiting" | "stuck" | "failed" | "stopped";

const stateWords: Readonly<Record<StateChipState, string>> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for you",
  stuck: "Stuck",
  failed: "Failed",
  stopped: "Stopped",
};

export type StateChipProps = {
  readonly state: StateChipState;
  /** The bot's identity colour, used by the working dot. */
  readonly color?: string | null;
  /** The pending count, shown only on the waiting chip. */
  readonly count?: number | undefined;
  readonly className?: string | undefined;
};

/**
 * One state, one visual: a dot plus the word, so state is never colour alone.
 * `data-state` is the hook a test or a stylesheet reads.
 */
export function StateChip({ state, color, count, className }: StateChipProps) {
  const style =
    color === undefined || color === null
      ? undefined
      : ({ "--pb-state-chip-color": color } as CSSProperties);

  return (
    <span
      className={["pb-state-chip", `pb-state-chip--${state}`, className].filter(Boolean).join(" ")}
      data-state={state}
      style={style}
    >
      <span className="pb-state-chip__dot" aria-hidden="true" />
      <span className="pb-state-chip__word">{stateWords[state]}</span>
      {state === "waiting" && count !== undefined ? <CountBadge count={count} /> : null}
    </span>
  );
}

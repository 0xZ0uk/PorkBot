import type { CSSProperties, ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./lib/utils.ts";

/** The badge tones the register ships; `neutral` is the default. */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "info" | "destructive";

export type BadgeProps = {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children: ReactNode;
};

const badgeVariants = cva(
  "inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-meta",
  {
    variants: {
      tone: {
        neutral: "bg-accent text-foreground border-border",
        accent: "bg-primary/14 text-primary border-primary/40",
        success: "bg-success/14 text-success border-success/40",
        warning: "bg-warning/14 text-warning border-warning/40",
        info: "bg-info/14 text-info border-info/40",
        destructive: "bg-destructive/14 text-destructive border-destructive/40",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

export type CountBadgeProps = {
  readonly count: number;
  readonly className?: string;
};

/** The "waiting for you" count; the chip carries the word, this carries the n. */
export function CountBadge({ count, className }: CountBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-w-4.5 items-center justify-center rounded-full bg-primary px-0.5 text-meta text-primary-foreground",
        className,
      )}
      data-count-badge
    >
      {count}
    </span>
  );
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

const stateChipVariants = cva("inline-flex items-center gap-1 whitespace-nowrap text-meta", {
  variants: {
    state: {
      idle: "text-muted-foreground",
      working: "text-foreground",
      waiting: "text-foreground",
      stuck: "text-foreground",
      failed: "text-foreground",
      stopped: "text-muted-foreground",
    },
  },
  defaultVariants: { state: "idle" },
});

const stateDotVariants = cva("size-2 flex-none rounded-full", {
  variants: {
    state: {
      idle: "bg-transparent border border-muted-foreground",
      working: "animate-pulse bg-(--pb-state-chip-color,var(--primary))",
      waiting: "bg-primary",
      stuck: "bg-warning",
      failed: "bg-destructive",
      stopped: "bg-transparent border border-muted-foreground",
    },
  },
  defaultVariants: { state: "idle" },
});

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
    <span className={cn(stateChipVariants({ state }), className)} data-state={state} style={style}>
      <span className={stateDotVariants({ state })} aria-hidden="true" />
      <span>{stateWords[state]}</span>
      {state === "waiting" && count !== undefined ? <CountBadge count={count} /> : null}
    </span>
  );
}

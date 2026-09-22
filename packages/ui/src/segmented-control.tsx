import { useRef } from "react";
import { cn } from "./lib/utils.ts";
import type { KeyboardEvent } from "react";

export type SegmentedControlOption = {
  readonly value: string;
  readonly label: string;
};

export type SegmentedControlProps = {
  readonly options: readonly SegmentedControlOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The group's accessible name. */
  readonly label: string;
  readonly className?: string;
};

/**
 * A segmented control: a small set of mutually exclusive views where the
 * active one is a filled segment rather than a word. It is the radio pattern —
 * one tab stop, arrows move and select, Home and End jump to the ends — so the
 * visible active state and the state a reader hears are the same fact.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps) {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  function move(offset: number, absolute?: number): void {
    const index = options.findIndex((option) => option.value === value);

    if (index === -1) {
      return;
    }

    const next = absolute ?? (index + offset + options.length) % options.length;
    const option = options[next];

    if (option !== undefined) {
      optionRefs.current.get(option.value)?.focus();
      onChange(option.value);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(0, options.length - 1);
    }
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-border bg-accent p-0.5",
        className,
      )}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        <button
          key={option.value}
          ref={(node) => {
            if (node === null) {
              optionRefs.current.delete(option.value);
            } else {
              optionRefs.current.set(option.value, node);
            }
          }}
          className={cn(
            "cursor-pointer rounded-full border-0 px-3 py-0.5 text-meta transition-colors",
            value === option.value
              ? "bg-card font-semibold text-foreground shadow-raised"
              : "bg-transparent text-muted-foreground hover:text-foreground",
          )}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

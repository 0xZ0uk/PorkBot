import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { cn } from "./lib/utils.ts";

export type SeparatorProps = {
  readonly orientation?: "horizontal" | "vertical";
  /** The name a vertical separator needs when it divides labelled groups. */
  readonly label?: string;
  readonly className?: string;
};

export function Separator({ orientation = "horizontal", label, className }: SeparatorProps) {
  return (
    <BaseSeparator
      orientation={orientation}
      aria-label={label}
      className={cn(
        "shrink-0 border-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full min-h-4 w-px self-stretch",
        className,
      )}
    />
  );
}

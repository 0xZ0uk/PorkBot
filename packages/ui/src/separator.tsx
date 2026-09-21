export type SeparatorProps = {
  readonly orientation?: "horizontal" | "vertical";
  /** The name a vertical separator needs when it divides labelled groups. */
  readonly label?: string;
  readonly className?: string;
};

export function Separator({ orientation = "horizontal", label, className }: SeparatorProps) {
  return (
    <hr
      className={["pb-separator", `pb-separator--${orientation}`, className]
        .filter(Boolean)
        .join(" ")}
      aria-orientation={orientation}
      aria-label={label}
    />
  );
}

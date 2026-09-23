import type { ComponentPropsWithoutRef } from "react";
import { cva } from "class-variance-authority";
import { Icon } from "./icon.tsx";
import type { IconName } from "./icon.tsx";
import { Tooltip } from "./tooltip.tsx";
import { cn } from "./lib/utils.ts";

/** The four roles a button can take, from the register's Button row. */
export type ButtonVariant = "primary" | "neutral" | "ghost" | "destructive";

export type ButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className"> & {
  readonly variant?: ButtonVariant;
  /** Swaps the label for a spinner, marks the button busy and disables it. */
  readonly loading?: boolean;
  readonly className?: string | undefined;
};

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-transparent px-3 py-2 font-sans text-body font-medium no-underline disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress",
  {
    variants: {
      variant: {
        primary: "border-primary bg-primary text-primary-foreground hover:bg-primary-hover",
        neutral: "border-border bg-card text-foreground hover:bg-accent",
        ghost: "bg-transparent text-foreground hover:bg-accent",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive-hover",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

/**
 * The one button. Variant, hover, focus-visible, disabled and loading are the
 * register's states; the caller supplies intent (a label, an action) and no
 * chrome.
 */
export function Button({
  variant = "neutral",
  loading = false,
  className,
  children,
  disabled = false,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant }), className)}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? (
        <span
          className="size-3.5 animate-spin rounded-full border-2 border-current/35 border-t-current"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "children"> & {
  /** The accessible name; visible copy, so the icon can stay decorative. */
  readonly label: string;
  readonly icon: IconName;
  readonly variant?: ButtonVariant;
  /** An optional tooltip on hover and focus; the label is used when omitted. */
  readonly tooltip?: string;
  readonly className?: string | undefined;
};

const iconButtonVariants = cva(
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-transparent p-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground",
        neutral: "border-border bg-card text-foreground",
        ghost: "bg-transparent text-foreground",
        destructive: "bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: { variant: "ghost" },
  },
);

/** A square, icon-only control; it always carries its accessible name. */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  tooltip,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      className={cn(iconButtonVariants({ variant }), className)}
      type={type}
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} aria-hidden="true" />
    </button>
  );
  return tooltip === undefined ? button : <Tooltip content={tooltip}>{button}</Tooltip>;
}

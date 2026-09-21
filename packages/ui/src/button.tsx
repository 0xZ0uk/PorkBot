import type { ComponentPropsWithoutRef } from "react";
import { Icon } from "./icon.tsx";
import type { IconName } from "./icon.tsx";
import { Tooltip } from "./tooltip.tsx";

/** The four roles a button can take, from the register's Button row. */
export type ButtonVariant = "primary" | "neutral" | "ghost" | "destructive";

export type ButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className"> & {
  readonly variant?: ButtonVariant;
  /** Swaps the label for a spinner, marks the button busy and disables it. */
  readonly loading?: boolean;
  readonly className?: string;
};

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
      className={["pb-button", `pb-button--${variant}`, className].filter(Boolean).join(" ")}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? <span className="pb-button__spinner" aria-hidden="true" /> : null}
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
  readonly className?: string;
};

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
      className={["pb-icon-button", `pb-icon-button--${variant}`, className]
        .filter(Boolean)
        .join(" ")}
      type={type}
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );

  return <Tooltip content={tooltip ?? label}>{button}</Tooltip>;
}

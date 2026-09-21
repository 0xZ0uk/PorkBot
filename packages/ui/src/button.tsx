import type { ReactNode } from "react";
import { colors, font, radius, space } from "@porkbot/tokens";

export type ButtonProps = {
  children: ReactNode;
  tone?: "neutral" | "primary";
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
};

export function Button({
  children,
  tone = "neutral",
  type = "button",
  onClick,
  disabled = false,
}: ButtonProps) {
  const palette =
    tone === "primary"
      ? {
          background: colors.accent,
          color: colors.accentForeground,
          borderColor: colors.accent,
        }
      : {
          background: colors.surface,
          color: colors.foreground,
          borderColor: colors.border,
        };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...palette,
        borderStyle: "solid",
        borderWidth: "1px",
        borderRadius: radius.md,
        padding: `${space.sm} ${space.md}`,
        fontFamily: font.sans,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

import type { ReactNode } from "react";
import { colors, font, radius, space } from "@porkbot/tokens";

export type ButtonProps = {
  children: ReactNode;
  tone?: "neutral" | "primary";
  type?: "button" | "submit";
};

export function Button({ children, tone = "neutral", type = "button" }: ButtonProps) {
  const palette =
    tone === "primary"
      ? { background: colors.accent, color: colors.onAccent, borderColor: colors.accent }
      : { background: colors.surface, color: colors.text, borderColor: colors.border };

  return (
    <button
      type={type}
      style={{
        ...palette,
        borderStyle: "solid",
        borderWidth: "1px",
        borderRadius: radius.md,
        padding: `${space.sm} ${space.md}`,
        fontFamily: font.sans,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

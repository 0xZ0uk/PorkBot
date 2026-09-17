export const colors = {
  background: "#0b0b0f",
  surface: "#16161d",
  border: "#2a2a35",
  text: "#f4f4f5",
  textMuted: "#a1a1aa",
  accent: "#f97316",
  onAccent: "#1a0f05",
  danger: "#ef4444",
} as const;

export const space = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "1rem",
  lg: "1.5rem",
  xl: "2.5rem",
} as const;

export const radius = {
  sm: "4px",
  md: "8px",
  pill: "999px",
} as const;

export const font = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

export const moduleInfo = {
  name: "@porkbot/tokens",
  summary: "Design tokens shared by every surface.",
} as const;

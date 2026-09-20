/**
 * The design tokens every surface builds against (AGENTS.md, UI).
 *
 * `palette` is the shadcn theme in its two modes and `colors` is the runtime
 * half: component code writes `colors.primary` and gets
 * `var(--pb-color-primary)`, so one stylesheet serves both modes and no
 * surface carries a literal. `theme.ts` in `@porkbot/web` turns `palette` into
 * those custom properties for the first paint, and the desktop's setup page
 * does the same for the one page that renders before the bundle runs.
 */

export const palette = {
  light: {
    background: "oklch(1.0000 0 0)",
    foreground: "oklch(0.3211 0 0)",
    card: "oklch(1.0000 0 0)",
    cardForeground: "oklch(0.3211 0 0)",
    popover: "oklch(1.0000 0 0)",
    popoverForeground: "oklch(0.3211 0 0)",
    primary: "oklch(0.6231 0.1880 259.8145)",
    primaryForeground: "oklch(1.0000 0 0)",
    secondary: "oklch(0.9670 0.0029 264.5419)",
    secondaryForeground: "oklch(0.4461 0.0263 256.8018)",
    muted: "oklch(0.9846 0.0017 247.8389)",
    mutedForeground: "oklch(0.5510 0.0234 264.3637)",
    accent: "oklch(0.9514 0.0250 236.8242)",
    accentForeground: "oklch(0.3791 0.1378 265.5222)",
    destructive: "oklch(0.6368 0.2078 25.3313)",
    destructiveForeground: "oklch(1.0000 0 0)",
    border: "oklch(0.9276 0.0058 264.5313)",
    input: "oklch(0.9276 0.0058 264.5313)",
    ring: "oklch(0.6231 0.1880 259.8145)",
    chart1: "oklch(0.6231 0.1880 259.8145)",
    chart2: "oklch(0.5461 0.2152 262.8809)",
    chart3: "oklch(0.4882 0.2172 264.3763)",
    chart4: "oklch(0.4244 0.1809 265.6377)",
    chart5: "oklch(0.3791 0.1378 265.5222)",
    sidebar: "oklch(0.9846 0.0017 247.8389)",
    sidebarForeground: "oklch(0.3211 0 0)",
    sidebarPrimary: "oklch(0.6231 0.1880 259.8145)",
    sidebarPrimaryForeground: "oklch(1.0000 0 0)",
    sidebarAccent: "oklch(0.9514 0.0250 236.8242)",
    sidebarAccentForeground: "oklch(0.3791 0.1378 265.5222)",
    sidebarBorder: "oklch(0.9276 0.0058 264.5313)",
    sidebarRing: "oklch(0.6231 0.1880 259.8145)",
  },
  dark: {
    background: "oklch(0.2046 0 0)",
    foreground: "oklch(0.9219 0 0)",
    card: "oklch(0.2686 0 0)",
    cardForeground: "oklch(0.9219 0 0)",
    popover: "oklch(0.2686 0 0)",
    popoverForeground: "oklch(0.9219 0 0)",
    primary: "oklch(0.6231 0.1880 259.8145)",
    primaryForeground: "oklch(1.0000 0 0)",
    secondary: "oklch(0.2686 0 0)",
    secondaryForeground: "oklch(0.9219 0 0)",
    muted: "oklch(0.2393 0 0)",
    mutedForeground: "oklch(0.7155 0 0)",
    accent: "oklch(0.3791 0.1378 265.5222)",
    accentForeground: "oklch(0.8823 0.0571 254.1284)",
    destructive: "oklch(0.6368 0.2078 25.3313)",
    destructiveForeground: "oklch(1.0000 0 0)",
    border: "oklch(0.3715 0 0)",
    input: "oklch(0.3715 0 0)",
    ring: "oklch(0.6231 0.1880 259.8145)",
    chart1: "oklch(0.7137 0.1434 254.6240)",
    chart2: "oklch(0.6231 0.1880 259.8145)",
    chart3: "oklch(0.5461 0.2152 262.8809)",
    chart4: "oklch(0.4882 0.2172 264.3763)",
    chart5: "oklch(0.4244 0.1809 265.6377)",
    sidebar: "oklch(0.2046 0 0)",
    sidebarForeground: "oklch(0.9219 0 0)",
    sidebarPrimary: "oklch(0.6231 0.1880 259.8145)",
    sidebarPrimaryForeground: "oklch(1.0000 0 0)",
    sidebarAccent: "oklch(0.3791 0.1378 265.5222)",
    sidebarAccentForeground: "oklch(0.8823 0.0571 254.1284)",
    sidebarBorder: "oklch(0.3715 0 0)",
    sidebarRing: "oklch(0.6231 0.1880 259.8145)",
  },
} as const;

export type ThemeMode = keyof typeof palette;
export type Palette = (typeof palette)["light"];

/** `cardForeground` is the custom property `--pb-color-card-foreground`. */
function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (cap) => `-${cap.toLowerCase()}`).replace(/([a-z])(\d)/g, "$1-$2");
}

/** One mode's values as the custom properties a stylesheet declares. */
export function cssCustomProperties(
  prefix: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values)
    .map(([name, value]) => `--pb-${prefix}-${kebabCase(name)}:${value};`)
    .join("");
}

/**
 * The same palette as references, for code that renders style rather than CSS:
 * the property resolves against whichever mode the stylesheet declared.
 */
export const colors = Object.fromEntries(
  Object.keys(palette.light).map((name) => [name, `var(--pb-color-${kebabCase(name)})`]),
) as Readonly<Record<keyof Palette, string>>;

/**
 * The palette's brand colour as sRGB, for the one consumer a custom property
 * cannot serve: a native `<input type="color">` takes a literal, not a
 * reference, so a user-owned default has to be a value. It is the sRGB
 * equivalent of the light primary.
 */
export const srgbPrimary = "#3b82f6";

export const space = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "1rem",
  lg: "1.5rem",
  xl: "2.5rem",
} as const;

/** The shadcn scale: `--radius` is 0.375rem and each step is derived from it. */
export const radius = {
  sm: "0.125rem",
  md: "0.25rem",
  lg: "0.375rem",
  xl: "0.625rem",
  pill: "999px",
} as const;

export const font = {
  sans: '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

export const moduleInfo = {
  name: "@porkbot/tokens",
  summary: "Design tokens shared by every surface.",
} as const;

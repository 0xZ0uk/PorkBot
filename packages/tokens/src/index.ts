/**
 * The design tokens every surface builds against (AGENTS.md, UI; the interface
 * design record at docs/architecture/interface.md).
 *
 * `palette` is PorkBot's own theme in its two modes: monochrome surfaces, one
 * warm accent, the state colours and a twelve-position identity ramp. `colors`
 * is the runtime half — component code writes `colors.accent` and gets
 * `var(--pb-color-accent)` — so one stylesheet serves both modes and no surface
 * carries a literal. `themeStyleSheet` turns the palette and the scales into
 * those custom properties for the first paint, and both the web shell and the
 * desktop's setup page inline it.
 *
 * Every identity hue and every state colour is measured against the surfaces it
 * is used on; `index.test.ts` holds the contrast floors and the design record
 * states the numbers, so a value change is a test failure rather than a
 * judgement call.
 */

export const palette = {
  light: {
    background: "oklch(0.9850 0.0020 285)",
    surface: "oklch(1.0000 0 0)",
    raised: "oklch(0.9650 0.0030 285)",
    foreground: "oklch(0.2400 0.0100 285)",
    muted: "oklch(0.5000 0.0120 285)",
    border: "oklch(0.9000 0.0050 285)",
    accent: "oklch(0.5720 0.2345 350)",
    accentForeground: "oklch(0.9900 0.0040 350)",
    success: "oklch(0.5250 0.1422 150)",
    warning: "oklch(0.5450 0.1132 75)",
    info: "oklch(0.5370 0.1210 240)",
    destructive: "oklch(0.5670 0.2238 30)",
    destructiveForeground: "oklch(0.9900 0.0040 30)",
    identity1: "oklch(0.6000 0.1470 15)",
    identity2: "oklch(0.6000 0.1470 45)",
    identity3: "oklch(0.6000 0.1244 75)",
    identity4: "oklch(0.6000 0.1251 105)",
    identity5: "oklch(0.6000 0.1470 135)",
    identity6: "oklch(0.6000 0.1239 165)",
    identity7: "oklch(0.6000 0.1005 195)",
    identity8: "oklch(0.6000 0.1116 225)",
    identity9: "oklch(0.6000 0.1470 255)",
    identity10: "oklch(0.6000 0.1470 285)",
    identity11: "oklch(0.6000 0.1470 315)",
    identity12: "oklch(0.6000 0.1470 345)",
  },
  dark: {
    background: "oklch(0.1600 0.0050 285)",
    surface: "oklch(0.2000 0.0060 285)",
    raised: "oklch(0.2400 0.0070 285)",
    foreground: "oklch(0.9300 0.0040 285)",
    muted: "oklch(0.6800 0.0120 285)",
    border: "oklch(0.2900 0.0080 285)",
    accent: "oklch(0.7200 0.2055 350)",
    accentForeground: "oklch(0.1800 0.0100 350)",
    success: "oklch(0.7200 0.1945 150)",
    warning: "oklch(0.7200 0.1491 75)",
    info: "oklch(0.7200 0.1595 240)",
    destructive: "oklch(0.7200 0.1715 30)",
    destructiveForeground: "oklch(0.1800 0.0100 30)",
    identity1: "oklch(0.7200 0.1274 15)",
    identity2: "oklch(0.7200 0.1274 45)",
    identity3: "oklch(0.7200 0.1274 75)",
    identity4: "oklch(0.7200 0.1274 105)",
    identity5: "oklch(0.7200 0.1274 135)",
    identity6: "oklch(0.7200 0.1274 165)",
    identity7: "oklch(0.7200 0.1205 195)",
    identity8: "oklch(0.7200 0.1274 225)",
    identity9: "oklch(0.7200 0.1274 255)",
    identity10: "oklch(0.7200 0.1274 285)",
    identity11: "oklch(0.7200 0.1274 315)",
    identity12: "oklch(0.7200 0.1274 345)",
  },
} as const;

export type ThemeMode = keyof typeof palette;
export type Palette = (typeof palette)["light"];

/** `accentForeground` is the custom property `--pb-color-accent-foreground`. */
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
 * The accent as sRGB, for the one consumer a custom property cannot serve: a
 * native `<input type="color">` takes a literal, not a reference, so a
 * user-owned default has to be a value. It is the sRGB equivalent of the light
 * accent, and `index.test.ts` fails when the two drift.
 */
export const srgbAccent = "#d20c8b";

/** The space scale: a 4px rhythm with no holes, so a dense list has a step. */
export const space = {
  "2xs": "0.125rem",
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
  "3xl": "3rem",
  "4xl": "4rem",
} as const;

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

/**
 * The type scale. Sizes descend from `display` to `meta` in declaration order;
 * `code` is the monospace step between body and meta, not a rank of its own.
 */
export const typeScale = {
  display: { size: "1.5rem", lineHeight: "2rem", weight: "600" },
  title: { size: "1.125rem", lineHeight: "1.5rem", weight: "600" },
  heading: { size: "0.9375rem", lineHeight: "1.375rem", weight: "600" },
  body: { size: "0.875rem", lineHeight: "1.375rem", weight: "400" },
  code: { size: "0.8125rem", lineHeight: "1.25rem", weight: "400" },
  meta: { size: "0.75rem", lineHeight: "1rem", weight: "500" },
} as const;

/**
 * The elevation scale. Dark mode elevates by surface lightness rather than by
 * shadow, so the shadow values are the light ones and the dark surfaces carry
 * the depth.
 */
export const elevation = {
  flat: "none",
  raised: "0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10)",
  overlay: "0 8px 24px rgb(0 0 0 / 0.18)",
} as const;

/**
 * The motion budget: four durations, two easings and the ambient pulse the
 * working state owns. Nothing else animates (design record, Motion).
 */
export const motion = {
  instant: "0ms",
  fast: "120ms",
  base: "180ms",
  slow: "240ms",
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  ambient: "2000ms",
} as const;

/** The type scale flattened to `--pb-type-<step>-<size|line-height|weight>`. */
const typeProperties = Object.fromEntries(
  Object.entries(typeScale).flatMap(([step, value]) => [
    [`${step}Size`, value.size],
    [`${step}LineHeight`, value.lineHeight],
    [`${step}Weight`, value.weight],
  ]),
) as Readonly<Record<string, string>>;

/**
 * The shadcn semantic set, mapped from PorkBot's palette.
 *
 * The two vocabularies mean different things by "accent": shadcn's `primary` is
 * the brand action colour (PorkBot's `accent`) and shadcn's `accent` is the
 * hover surface (PorkBot's `raised`). The mapping lives here, once, so
 * `globals.css`'s `@theme inline` block and the vendored shadcn components read
 * the same values and a palette change is still one file.
 */
function shadcnProperties(mode: ThemeMode): string {
  const theme = palette[mode];
  const variables: ReadonlyArray<readonly [string, string]> = [
    ["background", theme.background],
    ["foreground", theme.foreground],
    ["card", theme.surface],
    ["card-foreground", theme.foreground],
    ["popover", theme.surface],
    ["popover-foreground", theme.foreground],
    ["primary", theme.accent],
    ["primary-foreground", theme.accentForeground],
    ["secondary", theme.raised],
    ["secondary-foreground", theme.foreground],
    ["muted", theme.raised],
    ["muted-foreground", theme.muted],
    ["accent", theme.raised],
    ["accent-foreground", theme.foreground],
    ["destructive", theme.destructive],
    ["destructive-foreground", theme.destructiveForeground],
    ["border", theme.border],
    ["input", theme.border],
    ["ring", theme.accent],
    ["chart-1", theme.identity1],
    ["chart-2", theme.identity4],
    ["chart-3", theme.identity7],
    ["chart-4", theme.success],
    ["chart-5", theme.warning],
    ["sidebar", theme.raised],
    ["sidebar-foreground", theme.foreground],
    ["sidebar-primary", theme.accent],
    ["sidebar-primary-foreground", theme.accentForeground],
    ["sidebar-accent", theme.surface],
    ["sidebar-accent-foreground", theme.foreground],
    ["sidebar-border", theme.border],
    ["sidebar-ring", theme.accent],
    ["radius", radius.lg],
  ];
  return variables.map(([name, value]) => `--${name}:${value};`).join("");
}

/** One mode's custom properties: `color-scheme`, the palette and every scale. */
function modeProperties(mode: ThemeMode): string {
  return (
    `color-scheme:${mode};` +
    cssCustomProperties("color", palette[mode]) +
    cssCustomProperties("space", space) +
    cssCustomProperties("radius", radius) +
    cssCustomProperties("font", font) +
    cssCustomProperties("type", typeProperties) +
    cssCustomProperties("elevation", elevation) +
    cssCustomProperties("motion", motion) +
    shadcnProperties(mode)
  );
}

/**
 * The theme as a stylesheet: `:root` declares light, the media query swaps in
 * dark, and an explicit `data-theme` choice wins over both by coming last, so a
 * deliberate choice is not reversed by the OS. A surface appends its own
 * element rules after the properties.
 */
export const themeStyleSheet =
  `:root{${modeProperties("light")}}` +
  `@media (prefers-color-scheme:dark){:root{${modeProperties("dark")}}}` +
  `[data-theme="light"]{${modeProperties("light")}}` +
  `[data-theme="dark"]{${modeProperties("dark")}}`;

/** Where a browser stores the operator's explicit mode choice. */
export const themeStorageKey = "porkbot.theme";

/**
 * The pre-paint script the shell runs before the bundle: a stored `light` or
 * `dark` sets `data-theme`, and anything else — no key, a stored `system`
 * choice, an unknown value — leaves the system preference in charge. It is
 * inlined beside the stylesheet, so there is no flash of the wrong mode.
 */
export const themeBootstrapScript =
  `try{var t=localStorage.getItem(${JSON.stringify(themeStorageKey)});` +
  `if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

export const moduleInfo = {
  name: "@porkbot/tokens",
  summary: "Design tokens shared by every surface.",
} as const;

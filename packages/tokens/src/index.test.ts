import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  colors,
  cssCustomProperties,
  elevation,
  font,
  moduleInfo,
  motion,
  palette,
  radius,
  space,
  srgbAccent,
  themeBootstrapScript,
  themeStorageKey,
  themeStyleSheet,
  typeScale,
} from "./index.ts";

/**
 * The palette is measured, not eyeballed. These helpers are the sRGB and WCAG
 * arithmetic the design record's numbers come from: an oklch value is converted
 * to linear sRGB, relative luminance and a contrast ratio, and the ramp's
 * distinctness is an OKLab distance.
 */

type Oklch = readonly [number, number, number];

function parseOklch(value: string): Oklch {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);

  if (match === null) {
    throw new Error(`Not an oklch value: ${value}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function toLinearSrgb([lightness, chroma, hue]: Oklch): readonly [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb: readonly [number, number, number]): boolean {
  const epsilon = 0.0005;
  return rgb.every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const clamp = (channel: number) => Math.min(1, Math.max(0, channel));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(toLinearSrgb(parseOklch(first)));
  const b = relativeLuminance(toLinearSrgb(parseOklch(second)));
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

function toHex(value: string): string {
  const encode = (channel: number) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(255 * srgb)
      .toString(16)
      .padStart(2, "0");
  };

  return `#${toLinearSrgb(parseOklch(value)).map(encode).join("")}`;
}

function oklabDistance(first: Oklch, second: Oklch): number {
  const toLab = ([lightness, chroma, hue]: Oklch) => {
    const radians = (hue * Math.PI) / 180;
    return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)] as const;
  };
  const a = toLab(first);
  const b = toLab(second);

  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function parseDuration(value: string): number {
  const match = /^(\d+)ms$/.exec(value);

  if (match === null) {
    throw new Error(`Not a duration: ${value}`);
  }

  return Number(match[1]);
}

function parseLength(value: string): number {
  const match = /^([\d.]+)(rem|px)$/.exec(value);

  if (match === null) {
    throw new Error(`Not a length: ${value}`);
  }

  return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}

const modes = ["light", "dark"] as const;
const surfaces = ["background", "surface", "raised"] as const;
const states = ["accent", "success", "warning", "info", "destructive"] as const;

function identitySlots(): readonly (keyof typeof palette.light)[] {
  return Object.keys(palette.light).filter((name) =>
    name.startsWith("identity"),
  ) as readonly (keyof typeof palette.light)[];
}

describe("@porkbot/tokens", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/tokens");
  });

  it("declares the same colour slots in both modes", () => {
    expect(Object.keys(palette.light)).toEqual(Object.keys(palette.dark));
  });

  it("keeps every palette value an in-gamut oklch colour", () => {
    for (const mode of modes) {
      for (const [name, value] of Object.entries(palette[mode])) {
        expect(value, name).toMatch(/^oklch\(/);
        expect(inGamut(toLinearSrgb(parseOklch(value))), `${mode}.${name}`).toBe(true);
      }
    }
  });

  it("turns a camelCase slot into its custom property name", () => {
    expect(cssCustomProperties("color", { cardForeground: "red", chart1: "blue" })).toBe(
      "--pb-color-card-foreground:red;--pb-color-chart-1:blue;",
    );
  });

  it("points every runtime colour at the property the palette declares", () => {
    expect(Object.keys(colors)).toEqual(Object.keys(palette.light));
    expect(colors.accentForeground).toBe("var(--pb-color-accent-foreground)");
    expect(colors.identity12).toBe("var(--pb-color-identity-12)");
  });

  it("keeps the sRGB accent literal on the light accent", () => {
    expect(toHex(palette.light.accent)).toBe(srgbAccent);
  });

  describe("identity ramp", () => {
    it("holds twelve hues, one every 30 degrees, in both modes", () => {
      for (const mode of modes) {
        const hues = identitySlots().map((name) => parseOklch(palette[mode][name])[2]);

        expect(hues, mode).toHaveLength(12);
        hues.forEach((hue, index) => {
          expect(hue, `${mode} identity${index + 1}`).toBe(15 + 30 * index);
        });
      }
    });

    it("keeps every pair of hues at least 0.05 apart in OKLab", () => {
      for (const mode of modes) {
        const ramp = identitySlots().map((name) => parseOklch(palette[mode][name]));
        let closest = Number.POSITIVE_INFINITY;

        for (let first = 0; first < ramp.length; first += 1) {
          for (let second = first + 1; second < ramp.length; second += 1) {
            const firstValue = ramp[first];
            const secondValue = ramp[second];

            if (firstValue === undefined || secondValue === undefined) {
              continue;
            }

            closest = Math.min(closest, oklabDistance(firstValue, secondValue));
          }
        }

        expect(closest, mode).toBeGreaterThanOrEqual(0.05);
      }
    });

    it("reads as a fill on every surface in its own mode", () => {
      for (const mode of modes) {
        for (const name of identitySlots()) {
          for (const surface of surfaces) {
            expect(
              contrastRatio(palette[mode][name], palette[mode][surface]),
              `${mode}.${name} on ${surface}`,
            ).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
  });

  describe("state colours", () => {
    it("reads as text on every surface in its own mode", () => {
      for (const mode of modes) {
        for (const state of states) {
          for (const surface of surfaces) {
            expect(
              contrastRatio(palette[mode][state], palette[mode][surface]),
              `${mode}.${state} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });

    it("keeps the accent and destructive apart", () => {
      for (const mode of modes) {
        expect(
          oklabDistance(parseOklch(palette[mode].accent), parseOklch(palette[mode].destructive)),
          mode,
        ).toBeGreaterThanOrEqual(0.05);
      }
    });

    it("pairs the filled accent and destructive with a readable foreground", () => {
      for (const mode of modes) {
        expect(
          contrastRatio(palette[mode].accentForeground, palette[mode].accent),
          mode,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette[mode].destructiveForeground, palette[mode].destructive),
          mode,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("keeps body and muted text readable on every surface", () => {
      for (const mode of modes) {
        for (const text of ["foreground", "muted"] as const) {
          for (const surface of surfaces) {
            expect(
              contrastRatio(palette[mode][text], palette[mode][surface]),
              `${mode}.${text} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });
  });

  describe("scales", () => {
    it("spaces every step of the 4px rhythm", () => {
      const steps = Object.values(space).map(parseLength);

      for (let index = 1; index < steps.length; index += 1) {
        expect(steps[index], `space step ${index}`).toBeGreaterThan(steps[index - 1] ?? 0);
      }
    });

    it("radii every step", () => {
      const steps = Object.values(radius).map(parseLength);

      for (let index = 1; index < steps.length; index += 1) {
        expect(steps[index], `radius step ${index}`).toBeGreaterThan(steps[index - 1] ?? 0);
      }
    });

    it("orders the type steps from display to meta", () => {
      const steps = Object.values(typeScale);
      const sizes = steps.map((step) => parseLength(step.size));
      const lineHeights = steps.map((step) => parseLength(step.lineHeight));

      for (let index = 1; index < steps.length; index += 1) {
        expect(sizes[index], `size ${index}`).toBeLessThan(sizes[index - 1] ?? 0);
        expect(lineHeights[index], `line height ${index}`).toBeLessThanOrEqual(
          lineHeights[index - 1] ?? 0,
        );
      }

      for (const step of steps) {
        expect(Number(step.weight)).toBeGreaterThanOrEqual(400);
        expect(Number(step.weight)).toBeLessThanOrEqual(600);
      }
    });

    it("budgets the motion durations", () => {
      const durations = ["instant", "fast", "base", "slow", "ambient"].map((name) =>
        parseDuration(motion[name as keyof typeof motion]),
      );

      for (let index = 1; index < durations.length; index += 1) {
        expect(durations[index], `motion step ${index}`).toBeGreaterThan(durations[index - 1] ?? 0);
      }

      expect(motion.standard).toContain("cubic-bezier");
      expect(motion.exit).toContain("cubic-bezier");
      expect(Object.values(font).every((family) => family.length > 0)).toBe(true);
      expect(elevation.raised).toContain("rgb(0 0 0");
      expect(elevation.overlay).toContain("rgb(0 0 0");
      expect(elevation.flat).toBe("none");
    });
  });

  describe("the theme", () => {
    it("declares light first, dark behind the media query and the choice last", () => {
      const media = themeStyleSheet.indexOf("@media (prefers-color-scheme:dark)");
      const light = themeStyleSheet.indexOf('[data-theme="light"]');
      const dark = themeStyleSheet.indexOf('[data-theme="dark"]');

      expect(themeStyleSheet.startsWith(":root{color-scheme:light;")).toBe(true);
      expect(media).toBeGreaterThan(0);
      expect(light).toBeGreaterThan(media);
      expect(dark).toBeGreaterThan(light);
    });

    it("emits a custom property for every colour and every scale", () => {
      for (const mode of modes) {
        expect(themeStyleSheet).toContain(cssCustomProperties("color", palette[mode]));
      }

      for (const [prefix, values] of Object.entries({ space, radius, font, elevation, motion })) {
        expect(themeStyleSheet, prefix).toContain(cssCustomProperties(prefix, values));
      }

      for (const step of Object.keys(typeScale)) {
        expect(themeStyleSheet).toContain(`--pb-type-${step}-size:`);
        expect(themeStyleSheet).toContain(`--pb-type-${step}-line-height:`);
        expect(themeStyleSheet).toContain(`--pb-type-${step}-weight:`);
      }
    });

    it("applies a stored choice before the bundle runs", () => {
      const boot = (stored: string | null, explode = false): string | undefined => {
        const documentElement = { dataset: {} as Record<string, string> };
        const context = {
          localStorage: {
            getItem: (key: string) => {
              if (explode) {
                throw new Error("storage is unavailable");
              }
              return key === themeStorageKey ? stored : null;
            },
          },
          document: { documentElement },
        };

        runInNewContext(themeBootstrapScript, context);
        return documentElement.dataset["theme"];
      };

      expect(boot("light")).toBe("light");
      expect(boot("dark")).toBe("dark");
      expect(boot(null)).toBeUndefined();
      expect(boot("sepia")).toBeUndefined();
      expect(boot(null, true)).toBeUndefined();
    });
  });
});

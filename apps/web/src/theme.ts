import { colors, font, radius, space } from "@porkbot/tokens";

/**
 * The theme, generated from `@porkbot/tokens` rather than written as CSS.
 *
 * Every colour, space, radius and font in the shell is a custom property that
 * comes from the semantic tokens, so a theme change is one edit in the tokens
 * package and no surface file carries a literal. The lint rule in
 * `@porkbot/eslint-config` fails a hardcoded colour in a UI surface; this module
 * is how a surface gets one without writing it down.
 */

function customProperties(prefix: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(
      ([name, value]) =>
        `--pb-${prefix}-${name.replace(/[A-Z]/g, (cap) => `-${cap.toLowerCase()}`)}:${value};`,
    )
    .join("");
}

const baseStyles = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{height:100%}",
  "body{" +
    "margin:0;" +
    "background:var(--pb-color-background);" +
    "color:var(--pb-color-text);" +
    "font-family:var(--pb-font-sans);" +
    "line-height:1.5;" +
    "-webkit-font-smoothing:antialiased}",
  "a{color:var(--pb-color-accent)}",
  // One visible focus treatment everywhere, drawn in the accent colour so it
  // survives a theme change with everything else.
  "a:focus-visible,button:focus-visible,input:focus-visible{" +
    "outline:2px solid var(--pb-color-accent);" +
    "outline-offset:2px}",
].join("");

/** The single `<style>` the document shell inlines before the bundle runs. */
export const themeStyleSheet = `:root{color-scheme:dark;${customProperties("color", colors)}${customProperties("space", space)}${customProperties("radius", radius)}${customProperties("font", font)}}${baseStyles}`;

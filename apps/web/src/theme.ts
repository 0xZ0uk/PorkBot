import { cssCustomProperties, font, palette, radius, space } from "@porkbot/tokens";

/**
 * The theme, generated from `@porkbot/tokens` rather than written as CSS.
 *
 * Every colour, space, radius and font in the shell is a custom property that
 * comes from the semantic tokens, so a theme change is one edit in the tokens
 * package and no surface file carries a literal. The lint rule in
 * `@porkbot/eslint-config` fails a hardcoded colour in a UI surface; this module
 * is how a surface gets one without writing it down.
 *
 * Both modes ship in one sheet: `:root` declares the light palette and the
 * media query swaps the colour properties for the dark one, so the first paint
 * follows the system with no script and no flash. The scales do not change with
 * the mode and are declared once.
 */

const baseStyles = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{height:100%}",
  "body{" +
    "margin:0;" +
    "background:var(--pb-color-background);" +
    "color:var(--pb-color-foreground);" +
    "font-family:var(--pb-font-sans);" +
    "line-height:1.5;" +
    "-webkit-font-smoothing:antialiased}",
  "a{color:var(--pb-color-primary)}",
  // One visible focus treatment everywhere, drawn in the ring colour so it
  // survives a theme change with everything else.
  "a:focus-visible,button:focus-visible,input:focus-visible{" +
    "outline:2px solid var(--pb-color-ring);" +
    "outline-offset:2px}",
].join("");

const scales = `${cssCustomProperties("space", space)}${cssCustomProperties("radius", radius)}${cssCustomProperties("font", font)}`;

/** The single `<style>` the document shell inlines before the bundle runs. */
export const themeStyleSheet =
  `:root{color-scheme:light;${cssCustomProperties("color", palette.light)}${scales}}` +
  `@media (prefers-color-scheme:dark){:root{color-scheme:dark;${cssCustomProperties("color", palette.dark)}}}` +
  baseStyles;

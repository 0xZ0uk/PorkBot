import {
  themeBootstrapScript,
  themeStorageKey,
  themeStyleSheet as tokensThemeStyleSheet,
} from "@porkbot/tokens";

/**
 * The shell's theme: the tokens' mode-aware custom properties plus the base
 * element rules.
 *
 * `@porkbot/tokens` owns the values, the mode policy and the pre-paint
 * bootstrap; this module adds the document rules the shell needs on top. The
 * lint rule in `@porkbot/eslint-config` fails a hardcoded colour in a UI
 * surface, so this module is how a surface gets one without writing it down.
 */

const baseStyles = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{height:100%}",
  "body{" +
    "margin:0;" +
    "background:var(--pb-color-background);" +
    "color:var(--pb-color-foreground);" +
    "font-family:var(--pb-font-sans);" +
    "font-size:var(--pb-type-body-size);" +
    "line-height:var(--pb-type-body-line-height);" +
    "-webkit-font-smoothing:antialiased}",
  "a{color:var(--pb-color-accent)}",
  // One visible focus treatment everywhere, drawn in the accent so it survives
  // a theme change with everything else.
  "a:focus-visible,button:focus-visible,input:focus-visible{" +
    "outline:2px solid var(--pb-color-accent);" +
    "outline-offset:2px}",
].join("");

/** The single `<style>` the document shell inlines before the bundle runs. */
export const themeStyleSheet = `${tokensThemeStyleSheet}${baseStyles}`;

export { themeBootstrapScript, themeStorageKey };

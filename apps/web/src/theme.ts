import {
  themeBootstrapScript,
  themeStorageKey,
  themeStyleSheet as tokensThemeStyleSheet,
} from "@porkbot/tokens";
import { registerStyleSheet } from "@porkbot/ui";

/**
 * The shell's theme: the tokens' mode-aware custom properties, the base
 * element rules and the register's component rules.
 *
 * `@porkbot/tokens` owns the values, the mode policy and the pre-paint
 * bootstrap; `@porkbot/ui` owns the register's classes and their states; this
 * module adds the document rules the shell needs and puts the three in the one
 * `<style>` the shell inlines. The lint rules in `@porkbot/eslint-config` fail
 * a hardcoded colour and a hand-rolled primitive in a UI surface, so this
 * module is how a surface gets either without writing it down.
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
export const themeStyleSheet = `${tokensThemeStyleSheet}${baseStyles}${registerStyleSheet}`;

export { themeBootstrapScript, themeStorageKey };

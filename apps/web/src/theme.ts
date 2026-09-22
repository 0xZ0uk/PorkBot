import { registerStyleSheet } from "@porkbot/ui";
import {
  themeBootstrapScript,
  themeStyleSheet as tokensThemeStyleSheet,
  themeStorageKey,
} from "@porkbot/tokens";
import "./globals.css";

/**
 * The shell's theme: the token bootstrap plus the Tailwind entry.
 *
 * `@porkbot/tokens` owns the palette, the scales, the System/Light/Dark policy
 * and the pre-paint bootstrap; `globals.css` is the Tailwind entry whose
 * `@theme inline` block maps those variables into the Tailwind theme and whose
 * base layer carries the document rules. This module is the one import that
 * gives a surface both, so the built stylesheet and the inlined first paint
 * cannot drift apart.
 *
 * `registerStyleSheet` is the last pre-Tailwind string left in the chain: it
 * draws the `pb-*` classes `@porkbot/ui` still emits. The register is rebuilt
 * on Tailwind classes in slice 2 and this last term goes with it.
 */
export const themeStyleSheet = `${tokensThemeStyleSheet}${registerStyleSheet}`;

export { themeBootstrapScript, themeStorageKey };

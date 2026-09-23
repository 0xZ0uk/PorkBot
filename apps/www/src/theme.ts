import { themeBootstrapScript, themeStyleSheet, themeStorageKey } from "@porkbot/tokens";
import "./globals.css";

/**
 * The public site's theme: the token bootstrap plus the Tailwind entry.
 *
 * `@porkbot/tokens` owns the palette, the scales, the System/Light/Dark policy
 * and the pre-paint bootstrap; `globals.css` is the Tailwind entry whose
 * `@theme inline` block maps those variables into the Tailwind theme and whose
 * base layer carries the document rules. This module is the one import that
 * gives a surface both, so the built stylesheet and the inlined first paint
 * cannot drift apart.
 */
export { themeBootstrapScript, themeStyleSheet, themeStorageKey };

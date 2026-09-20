/**
 * The tray and window icon (slice 11.6), as a 16x16 PNG data URL.
 *
 * Embedding the bytes keeps the tray working in a development run and a
 * packaged one with no asset path to resolve, and it keeps the one image the
 * desktop ships in the source file that names it. The disc uses the palette's
 * primary colour, frozen at the sRGB literal `@porkbot/tokens` exports for
 * exactly this case; an image cannot import a token, so the value is written
 * into the bytes at the one place a tray pixel is defined.
 */

export const trayIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXElEQVR42mNgoBWwbvpmZd30LRGKrUjRCNJw27rp2380DBJLJKS5E4tGdNyJz+b/ROJEbAbcJsGA29gC7D+J2Ipc52N6gxoGUOYFigORKtFIcUKiSlKmSmYiFQAAMX17+Ov/w68AAAAASUVORK5CYII=";

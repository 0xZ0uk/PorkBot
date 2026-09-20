/**
 * The tray and window icon (slice 11.6), as a 16x16 PNG data URL.
 *
 * Embedding the bytes keeps the tray working in a development run and a
 * packaged one with no asset path to resolve, and it keeps the one image the
 * desktop ships in the source file that names it. The disc uses the accent
 * colour from `@porkbot/tokens`; an image cannot import a token, so the value
 * is frozen into the bytes at the one place a tray pixel is defined.
 */

export const trayIconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXElEQVR42mNgoBX4WSxm9bNYLBGKrUjRCNJw+2ex2H80DBJLJKS5E4tGdNyJz+b/ROJEbAbcJsGA29gC7D+J2Ipc52N6gxoGUOYFigORKtFIcUKiSlKmSmYiFQAAhLRfpP8Q0qEAAAAASUVORK5CYII=";

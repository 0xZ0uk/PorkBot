import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The static SPA build (slice 11.1).
 *
 * `spa.enabled` is the whole server story: TanStack Start prerenders one
 * `_shell.html` at build time and the router boots the app from it on the
 * client, so `vite build` emits `dist/client` — HTML, JS, CSS — with no SSR
 * server to run. The other half of the SPA contract is the rewrite any file
 * server applies (serve an existing file, otherwise `_shell.html`), which is
 * what `src/host.ts` does for the local stack and what the single TLS origin
 * does in a deployment.
 *
 * React's plugin must come after Start's, which is the order the generated
 * client entry expects.
 */
export default defineConfig({
  plugins: [
    tanstackStart({
      spa: { enabled: true },
    }),
    viteReact(),
  ],
  // The prerender boots Vite's preview server and fetches it over loopback.
  // Pin the listener to IPv4 because `localhost` can resolve to `::1` for the
  // bind and `127.0.0.1` for the fetch — inside a container it does — and the
  // build then dies with ECONNREFUSED before writing the shell.
  preview: { host: "127.0.0.1" },
});

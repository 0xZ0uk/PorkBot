export { createStaticServer, serviceName, shellFileName } from "./host.ts";
export type { StaticServerOptions } from "./host.ts";

export const moduleInfo = {
  name: "@porkbot/web",
  summary:
    "Static SPA shell: routing, auth screens and the design tokens, built once for the origin and Electron.",
} as const;

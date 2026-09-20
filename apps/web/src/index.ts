export { createStaticHandler, createStaticServer, serviceName, shellFileName } from "./host.ts";
export type {
  StaticDocument,
  StaticHandler,
  StaticHandlerOptions,
  StaticServerOptions,
} from "./host.ts";

export const moduleInfo = {
  name: "@porkbot/web",
  summary:
    "Static SPA: routing, auth screens, the streaming thread console and the design tokens, built once for the origin and Electron.",
} as const;

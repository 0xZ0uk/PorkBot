export { createApiServer, serviceName } from "./server.ts";

export const moduleInfo = {
  name: "@porkbot/api",
  summary: "HTTP and streaming surface (Hono + oRPC) over the domain.",
} as const;

export { serviceName } from "./app.ts";
export { createApiApp, rpcPath } from "./app.ts";
export type { ApiApp, ApiAppOptions, ApiServices } from "./app.ts";
export { createOpenApiDocument } from "./openapi.ts";
export type { OpenApiDocumentOptions } from "./openapi.ts";
export { createApiServer } from "./server.ts";

export const moduleInfo = {
  name: "@porkbot/api",
  summary: "HTTP and streaming surface (Hono + oRPC) over the domain.",
} as const;

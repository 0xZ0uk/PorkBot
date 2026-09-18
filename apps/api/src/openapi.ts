import { OpenAPIGenerator } from "@orpc/openapi";
import type { OpenAPI } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { appContract } from "@porkbot/contracts";

export interface OpenApiDocumentOptions {
  readonly title?: string;
  readonly version?: string;
}

/**
 * Generates the OpenAPI document from the same contract object the router
 * implements. This is the smoke test of the contract-first promise: if a
 * procedure is in the contract, it is in this document, and nothing here names
 * a procedure, a path or a schema a second time (PRD decision 14).
 */
export async function createOpenApiDocument(
  options: OpenApiDocumentOptions = {},
): Promise<OpenAPI.Document> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  return generator.generate(appContract, {
    info: {
      title: options.title ?? "PorkBot API",
      version: options.version ?? "0.0.0",
    },
  });
}

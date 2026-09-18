import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./openapi.ts";

describe("the OpenAPI document", () => {
  it("generates from the same contract the router implements", async () => {
    const document = await createOpenApiDocument({ title: "PorkBot API", version: "1.2.3" });

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info).toMatchObject({ title: "PorkBot API", version: "1.2.3" });
    expect(Object.keys(document.paths ?? {})).toContain("/deployment/status");
  });

  it("carries the procedure's method, operation id, output and typed error", async () => {
    const document = await createOpenApiDocument();
    const operation = document.paths?.["/deployment/status"]?.get;

    expect(operation).toMatchObject({ operationId: "deploymentStatus" });
    expect(operation?.responses?.["200"]).toBeDefined();
    expect(operation?.responses?.["503"]).toBeDefined();
  });
});

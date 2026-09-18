import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./openapi.ts";

describe("the OpenAPI document", () => {
  it("generates from the same contract the router implements", async () => {
    const document = await createOpenApiDocument({ title: "PorkBot API", version: "1.2.3" });

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info).toMatchObject({ title: "PorkBot API", version: "1.2.3" });
    expect(Object.keys(document.paths ?? {})).toEqual(
      expect.arrayContaining(["/deployment/status", "/account/me", "/bots/{id}"]),
    );
  });

  it("carries the procedure's method, operation id, output and typed error", async () => {
    const document = await createOpenApiDocument();
    const operation = document.paths?.["/deployment/status"]?.get;

    expect(operation).toMatchObject({ operationId: "deploymentStatus" });
    expect(operation?.responses?.["200"]).toBeDefined();
    expect(operation?.responses?.["503"]).toBeDefined();
  });

  it("carries the gate's typed errors for authenticated procedures", async () => {
    const document = await createOpenApiDocument();
    const account = document.paths?.["/account/me"]?.get;
    const bots = document.paths?.["/bots/{id}"]?.get;

    expect(account).toMatchObject({ operationId: "accountMe" });
    expect(account?.responses?.["401"]).toBeDefined();
    expect(bots).toMatchObject({ operationId: "botsGet" });
    expect(bots?.responses?.["404"]).toBeDefined();
  });
});

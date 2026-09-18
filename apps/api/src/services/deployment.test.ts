import { describe, expect, it } from "vitest";
import { DeploymentSettingsConflictError } from "@porkbot/effect";
import { createDeploymentStatusService } from "./deployment.ts";

describe("the deployment status service", () => {
  it("reports an explicitly open deployment as open", async () => {
    const service = createDeploymentStatusService(async () => ({
      signupsEnabled: true,
      adminEmail: "owner@example.test",
    }));

    expect(await service.status()).toEqual({ kind: "open" });
  });

  it("reports a missing settings row as closed, never as open", async () => {
    const service = createDeploymentStatusService(async () => null);

    expect(await service.status()).toEqual({ kind: "closed" });
  });

  it("reports signupsEnabled false as closed", async () => {
    const service = createDeploymentStatusService(async () => ({
      signupsEnabled: false,
      adminEmail: null,
    }));

    expect(await service.status()).toEqual({ kind: "closed" });
  });

  it("reports a conflicting configuration instead of guessing a row", async () => {
    const service = createDeploymentStatusService(async () => {
      throw new DeploymentSettingsConflictError(2);
    });

    expect(await service.status()).toEqual({ kind: "misconfigured" });
  });

  it("lets an unexpected read failure throw", async () => {
    const service = createDeploymentStatusService(async () => {
      throw new Error("connection refused");
    });

    await expect(service.status()).rejects.toThrow("connection refused");
  });
});

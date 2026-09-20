import { describe, expect, it } from "vitest";
import { DeploymentSettingsConflictError } from "@porkbot/effect";
import { createDeploymentService } from "./deployment.ts";

describe("the deployment status service", () => {
  it("reports an explicitly open deployment as open", async () => {
    const service = createDeploymentService(async () => ({
      signupsEnabled: true,
      adminEmail: "owner@example.test",
    }));

    expect(await service.status()).toEqual({ kind: "open" });
  });

  it("reports a missing settings row as closed, never as open", async () => {
    const service = createDeploymentService(async () => null);

    expect(await service.status()).toEqual({ kind: "closed" });
  });

  it("reports signupsEnabled false as closed", async () => {
    const service = createDeploymentService(async () => ({
      signupsEnabled: false,
      adminEmail: null,
    }));

    expect(await service.status()).toEqual({ kind: "closed" });
  });

  it("reports a conflicting configuration instead of guessing a row", async () => {
    const service = createDeploymentService(async () => {
      throw new DeploymentSettingsConflictError(2);
    });

    expect(await service.status()).toEqual({ kind: "misconfigured" });
  });

  it("lets an unexpected read failure throw", async () => {
    const service = createDeploymentService(async () => {
      throw new Error("connection refused");
    });

    await expect(service.status()).rejects.toThrow("connection refused");
  });
});

describe("the deployment ownership service", () => {
  it("answers the configured admin address", async () => {
    const service = createDeploymentService(async () => ({
      signupsEnabled: false,
      adminEmail: "owner@example.test",
    }));

    expect(await service.ownership()).toEqual({
      kind: "configured",
      ownerEmail: "owner@example.test",
    });
  });

  it("answers a null owner for a missing settings row, never an invented one", async () => {
    const service = createDeploymentService(async () => null);

    expect(await service.ownership()).toEqual({ kind: "configured", ownerEmail: null });
  });

  it("reports a conflicting configuration instead of claiming an owner", async () => {
    const service = createDeploymentService(async () => {
      throw new DeploymentSettingsConflictError(2);
    });

    expect(await service.ownership()).toEqual({ kind: "misconfigured" });
  });

  it("lets an unexpected read failure throw", async () => {
    const service = createDeploymentService(async () => {
      throw new Error("connection refused");
    });

    await expect(service.ownership()).rejects.toThrow("connection refused");
  });
});

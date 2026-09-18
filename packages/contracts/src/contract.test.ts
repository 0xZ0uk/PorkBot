import type { ContractRouterClient, ErrorFromErrorMap } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { appContract, signupAvailabilitySchema } from "./index.ts";
import type { AppClient, SignupAvailability } from "./index.ts";

describe("the application contract", () => {
  it("carries the deployment status procedure", () => {
    expect(appContract.deployment.status).toBeDefined();
    expect(appContract.deployment.status["~orpc"].route).toMatchObject({
      method: "GET",
      path: "/deployment/status",
    });
  });

  it("validates the signup availability as a closed set", () => {
    expect(signupAvailabilitySchema.safeParse("open").success).toBe(true);
    expect(signupAvailabilitySchema.safeParse("closed").success).toBe(true);
    expect(signupAvailabilitySchema.safeParse("maybe").success).toBe(false);
  });
});

describe("the client type", () => {
  it("is derived from the contract, not written beside it", () => {
    expectTypeOf<AppClient["deployment"]["status"]>().toBeFunction();
    expectTypeOf<Awaited<ReturnType<AppClient["deployment"]["status"]>>>().toEqualTypeOf<{
      signups: SignupAvailability;
    }>();
  });

  it("types each procedure's errors from the contract, never unknown", () => {
    type StatusErrors = ErrorFromErrorMap<
      (typeof appContract.deployment.status)["~orpc"]["errorMap"]
    >;
    type Codes = ErrorCodes<StatusErrors>;

    expectTypeOf<Codes>().toEqualTypeOf<"SERVICE_UNAVAILABLE">();
  });

  it("updates from a contract edit with no second declaration", () => {
    const fixtureContract = {
      pings: {
        send: oc
          .input(z.object({ count: z.number().int().min(0) }))
          .output(z.object({ sent: z.number().int() })),
      },
    };
    type FixtureClient = ContractRouterClient<typeof fixtureContract>;

    expect(fixtureContract.pings.send).toBeDefined();
    expectTypeOf<FixtureClient["pings"]["send"]>().parameter(0).toEqualTypeOf<{ count: number }>();
    expectTypeOf<Awaited<ReturnType<FixtureClient["pings"]["send"]>>>().toEqualTypeOf<{
      sent: number;
    }>();
  });
});

type ErrorCodes<T> = T extends { code: infer TCode } ? TCode : never;

import type { AnyContractProcedure, ErrorMap, Meta } from "@orpc/contract";
import { isContractProcedure } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import { procedureAccessSchema } from "./access.ts";
import { appContract, publicProcedures } from "./contract.ts";
import type { AppClient } from "./client.ts";

/**
 * The access rules the gate depends on, checked on the contract tree itself.
 *
 * The API's gate trusts two things: every procedure carries an access marker,
 * and every authenticated procedure declares the `UNAUTHORIZED` error the gate
 * throws. This test walks the tree and fails when either stops being true, and
 * it compares the public paths against the hand-written `publicProcedures`
 * inventory so "public" cannot be claimed by omission.
 */

interface ProcedureAt {
  readonly path: string;
  readonly procedure: AnyContractProcedure;
}

function walk(
  node: Record<string, unknown>,
  prefix: readonly string[] = [],
): readonly ProcedureAt[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = [...prefix, key];

    if (isContractProcedure(value)) {
      return [{ path: path.join("."), procedure: value }];
    }

    if (typeof value === "object" && value !== null) {
      return walk(value as Record<string, unknown>, path);
    }

    return [];
  });
}

const procedures = walk(appContract as unknown as Record<string, unknown>);

function metaOf(procedure: AnyContractProcedure): Meta {
  return procedure["~orpc"].meta;
}

function errorMapOf(procedure: AnyContractProcedure): ErrorMap {
  return procedure["~orpc"].errorMap;
}

describe("procedure access", () => {
  it("finds every procedure in the contract tree", () => {
    expect(procedures.map(({ path }) => path)).toEqual([
      "deployment.status",
      "account.me",
      "bots.get",
    ]);
  });

  it("marks every procedure as either authenticated or public", () => {
    expect(procedureAccessSchema.options).toEqual(["authenticated", "public"]);

    for (const { path, procedure } of procedures) {
      expect(metaOf(procedure)["access"], `${path} has no access marker`).toMatch(
        /^(authenticated|public)$/,
      );
    }
  });

  it("keeps the public inventory and the contract in step", () => {
    const declared = procedures
      .filter(({ procedure }) => metaOf(procedure)["access"] === "public")
      .map(({ path }) => path)
      .sort();

    expect(declared).toEqual([...publicProcedures].sort());
  });

  it("declares UNAUTHORIZED on every authenticated procedure", () => {
    for (const { path, procedure } of procedures) {
      if (metaOf(procedure)["access"] !== "authenticated") {
        continue;
      }

      expect(errorMapOf(procedure), `${path} must declare UNAUTHORIZED`).toHaveProperty(
        "UNAUTHORIZED",
      );
    }
  });

  it("carries no tenant id in an authenticated input", () => {
    // `bots.get` is the first authenticated by-id read: the client sends the
    // resource id, and the actor's scope comes from the session, never input.
    expectTypeOf<Parameters<AppClient["bots"]["get"]>[0]>().toEqualTypeOf<{ id: string }>();
  });
});

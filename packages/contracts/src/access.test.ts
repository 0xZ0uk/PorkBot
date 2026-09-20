import type { AnyContractProcedure, ErrorMap, Meta } from "@orpc/contract";
import { isContractProcedure } from "@orpc/contract";
import type { NotificationKind } from "@porkbot/core";
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
      "account.ownership",
      "notifications.preferences",
      "notifications.setPreference",
      "approvals.list",
      "approvals.decide",
      "bots.list",
      "bots.get",
      "bots.create",
      "bots.update",
      "bots.archive",
      "bots.restore",
      "bots.delete",
      "bots.setAvatar",
      "bots.avatar",
      "bots.clearAvatar",
      "botSecrets.list",
      "botSecrets.put",
      "botSecrets.remove",
      "computers.providers",
      "computers.status",
      "computers.boot",
      "computers.stop",
      "computers.reset",
      "computers.recover",
      "computers.snapshot",
      "computers.snapshots",
      "computers.restore",
      "sections.list",
      "sections.create",
      "sections.update",
      "sections.delete",
      "threads.create",
      "threads.list",
      "threads.messages",
      "threads.send",
      "threads.clear",
      "threads.toolResult",
      "threads.events",
      "runs.get",
      "runs.stop",
      "routines.list",
      "routines.create",
      "routines.update",
      "routines.remove",
      "routines.preview",
      "routines.testRun",
      "routines.outcomes",
      "memory.list",
      "memory.revisions",
      "memory.update",
      "memory.remove",
      "memory.restore",
      "usage.bot",
      "credentials.list",
      "credentials.store",
      "credentials.remove",
      "modelConnections.list",
      "modelConnections.create",
      "modelConnections.update",
      "modelConnections.setDefault",
      "modelConnections.remove",
      "modelConnections.probe",
      "mcpServers.list",
      "mcpServers.get",
      "mcpServers.create",
      "mcpServers.remove",
      "mcpServers.grants",
      "mcpServers.grant",
      "mcpServers.revoke",
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

  it("declares RATE_LIMITED on every procedure, public or not", () => {
    // The limiter runs before the access decision, so even a public procedure
    // can answer a typed 429 and a client can back off without parsing a
    // header. A new procedure inherits the declaration from its builder; this
    // walk fails if a builder ever stops declaring it.
    for (const { path, procedure } of procedures) {
      expect(errorMapOf(procedure), `${path} must declare RATE_LIMITED`).toHaveProperty(
        "RATE_LIMITED",
      );
    }
  });

  it("carries no tenant id in an authenticated input", () => {
    // `bots.get` is the first authenticated by-id read: the client sends the
    // resource id, and the actor's scope comes from the session, never input.
    expectTypeOf<Parameters<AppClient["bots"]["get"]>[0]>().toEqualTypeOf<{ id: string }>();

    // A notification switch names the kind and the value and nothing else: the
    // user and the space are the actor's, and there is no place to guess them.
    expectTypeOf<Parameters<AppClient["notifications"]["setPreference"]>[0]>().toEqualTypeOf<{
      kind: NotificationKind;
      enabled: boolean;
    }>();

    // The subscription names the thread it wants and nothing else: the resume
    // cursor is the Last-Event-ID header, and the space is the actor's.
    expectTypeOf<Parameters<AppClient["threads"]["events"]>[0]>().toEqualTypeOf<{
      threadId: string;
    }>();

    // Granting a server names the server and the bot and nothing else: the
    // space is the actor's, and the target bot is validated inside that scope.
    expectTypeOf<Parameters<AppClient["mcpServers"]["grant"]>[0]>().toEqualTypeOf<{
      id: string;
      botId: string;
    }>();
  });
});

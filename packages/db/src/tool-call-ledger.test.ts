import { NotFoundError } from "@porkbot/effect";
import type { ToolCall } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createExternalEffectLedger } from "./tool-call-ledger.ts";

/**
 * The ledger without a server: a recording fake stands in for the pg client, so
 * what these tests prove is the module's own contract — every statement binds
 * the actor's space, the claim is an insert with a conflict clause rather than
 * a read-then-write, a replay answers from the stored row, and an id reused for
 * a different request is a conflict. Whether the SQL is valid against Postgres,
 * and whether two racing claims really produce one winner, is not provable
 * here; the integration suite runs the same calls on the real thing.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[]): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  runId: "run-1",
  callId: "call-1",
  tool: "echo",
  arguments: { text: "hi" },
  ...overrides,
});

const began = (database: FakeDatabase): readonly QueryCall[] =>
  database.calls.filter(({ text }) => text.startsWith("insert into external_effect"));

describe("claiming a call", () => {
  it("inserts a running claim scoped to the actor's space, with the call id as the idempotency key", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("insert into external_effect") ? [{ id: "effect-1" }] : [],
    );
    const ledger = createExternalEffectLedger(worker, database);

    const admission = await ledger.begin(call());

    expect(admission).toEqual({ status: "started" });
    const [claim] = began(database);
    expect(claim?.text).toContain("on conflict (run_id, idempotency_key) do nothing");
    expect(claim?.values).toEqual([
      "space-1",
      "run-1",
      "echo",
      "call-1",
      JSON.stringify({ text: "hi" }),
    ]);
  });

  it("replays a completed claim from the stored row and never re-executes", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("insert into external_effect")
        ? []
        : [{ status: "completed", kind: "echo", sameRequest: true, result: { echoed: true } }],
    );
    const ledger = createExternalEffectLedger(worker, database);

    const admission = await ledger.begin(call());

    expect(admission).toEqual({ status: "completed", result: { echoed: true } });
    expect(database.calls[1]?.values).toEqual([
      "space-1",
      "run-1",
      "call-1",
      JSON.stringify({ text: "hi" }),
    ]);
  });

  it("replays a failed claim with the error it stored, and a generic one when the row carries none", async () => {
    const failed = (result: unknown) =>
      fakeDatabase(({ text }) =>
        text.startsWith("insert into external_effect")
          ? []
          : [{ status: "failed", kind: "echo", sameRequest: true, result }],
      );
    const withError = createExternalEffectLedger(worker, failed({ error: "it broke" }));
    const withoutError = createExternalEffectLedger(worker, failed(null));

    expect(await withError.begin(call())).toEqual({ status: "failed", error: "it broke" });
    expect(await withoutError.begin(call())).toEqual({
      status: "failed",
      error: "the tool call failed",
    });
  });

  it("refuses a call id whose stored request or tool differs", async () => {
    const reused = (row: Record<string, unknown>) =>
      fakeDatabase(({ text }) => (text.startsWith("insert into external_effect") ? [] : [row]));
    const differentArguments = createExternalEffectLedger(
      worker,
      reused({ status: "completed", kind: "echo", sameRequest: false, result: "wrong" }),
    );
    const differentTool = createExternalEffectLedger(
      worker,
      reused({ status: "completed", kind: "shell", sameRequest: true, result: "wrong" }),
    );

    expect(await differentArguments.begin(call())).toEqual({ status: "call_id_reused" });
    expect(await differentTool.begin(call())).toEqual({ status: "call_id_reused" });
  });

  it("refuses a claim that is not settled, whatever its unsettled status", async () => {
    for (const status of ["running", "pending", "cancelled"]) {
      const database = fakeDatabase(({ text }) =>
        text.startsWith("insert into external_effect")
          ? []
          : [{ status, kind: "echo", sameRequest: true, result: null }],
      );
      const ledger = createExternalEffectLedger(worker, database);

      expect(await ledger.begin(call()), status).toEqual({ status: "in_flight" });
    }
  });

  it("answers a run outside the actor's space as not-found and writes nothing", async () => {
    const database = fakeDatabase(() => []);
    const ledger = createExternalEffectLedger(worker, database);

    await expect(ledger.begin(call())).rejects.toBeInstanceOf(NotFoundError);
    expect(began(database)).toHaveLength(1);
    expect(database.calls[1]?.text).toContain("e.space_id = $1");
  });
});

describe("settling a claim", () => {
  it("records a completed result and returns it as recorded", async () => {
    const database = fakeDatabase(() => [{ id: "effect-1" }]);
    const ledger = createExternalEffectLedger(worker, database);

    const outcome = await ledger.complete(call(), { echoed: true });

    expect(outcome).toEqual({ status: "completed", result: { echoed: true } });
    const [update] = database.calls;
    expect(update?.text).toContain("status = 'completed'::effect_status");
    expect(update?.text).toContain("status = 'running'");
    expect(update?.values).toEqual([
      "space-1",
      "run-1",
      "call-1",
      JSON.stringify({ echoed: true }),
    ]);
  });

  it("settles a result the column cannot carry as failed instead of leaving the claim running", async () => {
    const database = fakeDatabase(() => [{ id: "effect-1" }]);
    const ledger = createExternalEffectLedger(worker, database);

    const outcome = await ledger.complete(call(), 10n);

    expect(outcome).toEqual({ status: "failed", error: "the tool result could not be recorded" });
    expect(database.calls[0]?.text).toContain("status = 'failed'::effect_status");
    expect(database.calls[0]?.values).toEqual([
      "space-1",
      "run-1",
      "call-1",
      "the tool result could not be recorded",
    ]);
    expect(database.calls).toHaveLength(1);
  });

  it("records a failure as a jsonb error object and returns it", async () => {
    const database = fakeDatabase(() => [{ id: "effect-1" }]);
    const ledger = createExternalEffectLedger(worker, database);

    const outcome = await ledger.fail(call(), "it broke");

    expect(outcome).toEqual({ status: "failed", error: "it broke" });
    expect(database.calls[0]?.text).toContain("jsonb_build_object('error', $4::text)");
    expect(database.calls[0]?.values).toEqual(["space-1", "run-1", "call-1", "it broke"]);
  });

  it("fails closed when the claim it admitted is no longer there to settle", async () => {
    const database = fakeDatabase(() => []);
    const ledger = createExternalEffectLedger(worker, database);

    await expect(ledger.complete(call(), { echoed: true })).rejects.toThrow(
      "the tool-call ledger no longer holds the claim it admitted",
    );
    await expect(ledger.fail(call(), "it broke")).rejects.toThrow(
      "the tool-call ledger no longer holds the claim it admitted",
    );
  });
});

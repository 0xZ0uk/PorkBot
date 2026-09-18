import { NotFoundError } from "@porkbot/effect";
import type { ToolCall, ToolCallAdmission, ToolCallLedger, ToolOutcome } from "@porkbot/effect";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of tool dispatch (slice 5.5, PRD decision 26), over the
 * `external_effect` table.
 *
 * Every tool call the dispatcher admits gets a row keyed by
 * `(run_id, idempotency_key)` before its side effect happens, where the key is
 * the call's durable `callId`. The unique index makes the claim atomic — two
 * racing attempts at the same call insert once and the loser reads the winner —
 * so "a retried effect is a no-op" is decided by Postgres rather than by a
 * read-then-write check. `kind` records which tool the id was claimed for and
 * `request` the arguments, so a call id reused for a different request is a
 * conflict instead of a replay of the wrong result.
 *
 * `status` carries the call's life: `running` from the claim until the handler
 * settles it as `completed` or `failed`. A claim still `running` when a retry
 * arrives is in flight, and the retry is refused rather than run twice; after a
 * crash the fence and the watchdog own that row (slices 6.2, 6.3), and it is
 * never replayed blindly. `result` is the handler's value on success and
 * `{ "error": "..." }` on failure, so a replay answers the model the same way
 * the original call did; a value jsonb cannot carry is settled as a fixed
 * failure rather than left claimed, because the alternative is a side effect
 * that happened whose outcome can never be replayed.
 *
 * The ledger is built from a `SystemActor` like every other data path here:
 * statements bind `space_id`, so a run in another space is a `NotFoundError`
 * and nothing is written. The tool name is the effect's `kind`, which is text
 * on purpose — new tools ride without a migration, and the registry above this
 * seam is what refuses a kind it does not know.
 */
export function createExternalEffectLedger(
  actor: SystemActor,
  database: Queryable,
): ToolCallLedger {
  return {
    async begin(call: ToolCall): Promise<ToolCallAdmission> {
      const { rows } = await database.query<{ readonly id: string }>(
        "insert into external_effect (space_id, run_id, kind, idempotency_key, status, request) " +
          "select $1, r.id, $3, $4, 'running'::effect_status, $5::jsonb " +
          "from run r where r.id = $2 and r.space_id = $1 " +
          "on conflict (run_id, idempotency_key) do nothing " +
          "returning id",
        [actor.spaceId, call.runId, call.tool, call.callId, argumentsJson(call)],
      );

      if (rows.length > 0) {
        return { status: "started" };
      }

      // No insert means the unique key was taken (the conflict clause settled
      // it), or the run is not in the actor's space. The scoped read tells the
      // two apart without leaking that the run exists elsewhere.
      const { rows: claimed } = await database.query<{
        readonly status: string;
        readonly kind: string;
        readonly sameRequest: boolean;
        readonly result: unknown;
      }>(
        'select e.status::text as status, e.kind as kind, e.request = $4::jsonb as "sameRequest", ' +
          "e.result as result from external_effect e " +
          "where e.space_id = $1 and e.run_id = $2 and e.idempotency_key = $3",
        [actor.spaceId, call.runId, call.callId, argumentsJson(call)],
      );

      const existing = claimed[0];

      if (existing === undefined) {
        throw new NotFoundError("run", call.runId);
      }

      if (existing.kind !== call.tool || !existing.sameRequest) {
        return { status: "call_id_reused" };
      }

      switch (existing.status) {
        case "completed":
          return { status: "completed", result: existing.result };
        case "failed":
          return { status: "failed", error: storedError(existing.result) };
        default:
          // pending, running and cancelled are all "not settled as this call":
          // the effect may be in progress or may never have run, and either way
          // re-running it is the one outcome the ledger exists to prevent.
          return { status: "in_flight" };
      }
    },

    async complete(call: ToolCall, result: unknown): Promise<ToolOutcome> {
      const serialized = serializeResult(result);

      // The result must survive the jsonb column for a replay to answer the
      // model. A value JSON cannot carry settles the claim as failed instead of
      // throwing after the side effect already happened, which would leave the
      // claim running and block every retry.
      if (!serialized.ok) {
        return await failClaim(database, actor, call, unrecordableResultMessage);
      }

      const { rows } = await database.query<{ readonly id: string }>(
        "update external_effect set status = 'completed'::effect_status, " +
          "result = $4::jsonb, updated_at = now() " +
          "where space_id = $1 and run_id = $2 and idempotency_key = $3 and status = 'running' " +
          "returning id",
        [actor.spaceId, call.runId, call.callId, serialized.json],
      );

      settled(rows);

      return { status: "completed", result };
    },

    async fail(call: ToolCall, error: string): Promise<ToolOutcome> {
      return await failClaim(database, actor, call, error);
    },
  };
}

/** The fixed failure a result the jsonb column cannot carry is settled as. */
const unrecordableResultMessage = "the tool result could not be recorded";

async function failClaim(
  database: Queryable,
  actor: SystemActor,
  call: ToolCall,
  error: string,
): Promise<ToolOutcome> {
  const { rows } = await database.query<{ readonly id: string }>(
    "update external_effect set status = 'failed'::effect_status, " +
      "result = jsonb_build_object('error', $4::text), updated_at = now() " +
      "where space_id = $1 and run_id = $2 and idempotency_key = $3 and status = 'running' " +
      "returning id",
    [actor.spaceId, call.runId, call.callId, error],
  );

  settled(rows);

  return { status: "failed", error };
}

/**
 * The settlement guard: the update's `status = 'running'` predicate makes
 * settling a function of the claim, and a second settling update matches
 * nothing. That is a failure rather than a silent no-op, because a call whose
 * outcome cannot be recorded cannot be retried safely.
 */
function settled(rows: readonly { readonly id: string }[]): void {
  if (rows.length === 0) {
    throw new Error("the tool-call ledger no longer holds the claim it admitted");
  }
}

type SerializedResult = { readonly ok: true; readonly json: string } | { readonly ok: false };

function serializeResult(result: unknown): SerializedResult {
  try {
    return { ok: true, json: JSON.stringify(result ?? null) ?? "null" };
  } catch {
    return { ok: false };
  }
}

function argumentsJson(call: ToolCall): string {
  return JSON.stringify(call.arguments ?? null) ?? "null";
}

function storedError(result: unknown): string {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const error = (result as Record<string, unknown>)["error"];

    if (typeof error === "string" && error !== "") {
      return error;
    }
  }

  return "the tool call failed";
}

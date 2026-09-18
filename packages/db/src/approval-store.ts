import { NotFoundError } from "@porkbot/effect";
import type {
  ApprovalDecisions,
  ApprovalRecord,
  ApprovalStore,
  ApprovalVoteInput,
  ApprovalVoteResult,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of the approval gate (slice 5.7, PRD decision 13; audit P0
 * item 1), over the `approval` table.
 *
 * The run's half (`ApprovalStore`) and the operator's half (`ApprovalDecisions`)
 * are built from different actors, exactly as `createRepositories` splits a
 * user's writes from a job's: a job opens a gate and settles a deadline, and a
 * user votes and reads the timeline. Every statement binds the actor's
 * `space_id`, so a run in another space is the shared `NotFoundError` and
 * nothing is written.
 *
 * Durability is the point. `open` is an insert with a conflict clause on
 * `(run_id, call_id)`, so two racing opens — a restarted worker beside the
 * dying one — produce one row and both wait on the original deadline.
 * `resolveTimeout` and `decide` are guarded compare-and-sets: timeout only
 * fires on a `pending` row whose `expires_at` has passed, a vote only on a
 * `pending` row before its deadline, and the loser of any race reads the row
 * and answers with the resolution that won. That is what makes "concurrent
 * approve/deny resolves exactly once" a database fact rather than a
 * read-then-write hope, and what records the decision with the user and the
 * instant that made it.
 *
 * A vote that arrives after the deadline settles the row as `timed_out` itself
 * rather than approving a gate the run is already resolving to deny, so the
 * deadline is a property of the row and not of who asked last.
 */
export const approvalColumns =
  'id, run_id as "runId", call_id as "callId", tool, status::text as "status", ' +
  'expires_at as "expiresAt", decided_by_user_id as "decidedBy", ' +
  'decided_at as "decidedAt", reason';

export function createApprovalStore(actor: SystemActor, database: Queryable): ApprovalStore;
export function createApprovalStore(actor: UserActor, database: Queryable): ApprovalDecisions;
export function createApprovalStore(
  actor: Actor,
  database: Queryable,
): ApprovalStore | ApprovalDecisions;
export function createApprovalStore(
  actor: Actor,
  database: Queryable,
): ApprovalStore | ApprovalDecisions {
  return actor.kind === "system"
    ? systemApprovalStore(actor, database)
    : userApprovalStore(actor, database);
}

function systemApprovalStore(actor: SystemActor, database: Queryable): ApprovalStore {
  return {
    async open(request): Promise<ApprovalRecord> {
      const { rows } = await database.query<ApprovalRecord>(
        "insert into approval (space_id, run_id, call_id, tool, status, expires_at) " +
          "select $1, r.id, $3, $4, 'pending'::approval_status, $5::timestamptz " +
          "from run r where r.id = $2 and r.space_id = $1 " +
          "on conflict (run_id, call_id) do nothing " +
          `returning ${approvalColumns}`,
        [
          actor.spaceId,
          request.runId,
          request.callId,
          request.tool,
          request.expiresAt.toISOString(),
        ],
      );

      if (rows.length > 0 && rows[0] !== undefined) {
        return rows[0];
      }

      // No insert means the key was taken or the run is not in the actor's
      // space; the scoped read tells the two apart without leaking a row.
      const existing = await findApproval(database, actor.spaceId, request.runId, request.callId);

      if (existing === undefined) {
        throw new NotFoundError("run", request.runId);
      }

      return existing;
    },

    async find(runId, callId): Promise<ApprovalRecord | undefined> {
      return await findApproval(database, actor.spaceId, runId, callId);
    },

    async resolveTimeout(runId, callId): Promise<ApprovalRecord> {
      const timedOut = await timeoutApproval(database, actor.spaceId, runId, callId);

      if (timedOut !== undefined) {
        return timedOut;
      }

      const existing = await findApproval(database, actor.spaceId, runId, callId);

      if (existing === undefined) {
        throw new NotFoundError("approval", callId);
      }

      // Still `pending` means the server clock has not reached the deadline,
      // and a resolved row means an operator got there first. Either way the
      // caller keeps its answer.
      return existing;
    },
  };
}

function userApprovalStore(actor: UserActor, database: Queryable): ApprovalDecisions {
  return {
    async decide(input: ApprovalVoteInput): Promise<ApprovalVoteResult> {
      const status = input.vote === "approve" ? "approved" : "denied";
      const { rows } = await database.query<ApprovalRecord>(
        "update approval set status = $4::approval_status, decided_by_user_id = $5, " +
          "decided_at = now(), reason = $6, updated_at = now() " +
          "where space_id = $1 and run_id = $2 and call_id = $3 " +
          "and status = 'pending'::approval_status and expires_at > now() " +
          `returning ${approvalColumns}`,
        [
          actor.spaceId,
          input.runId,
          input.callId,
          status,
          actor.userId,
          // The reason is the operator's deny text; an approval carries none,
          // and a blank deny reason is the absence of one rather than a wire
          // value the event vocabulary cannot carry.
          input.vote === "deny" && input.reason !== undefined && input.reason !== ""
            ? input.reason
            : null,
        ],
      );

      if (rows.length > 0 && rows[0] !== undefined) {
        return { record: rows[0], applied: true };
      }

      const existing = await findApproval(database, actor.spaceId, input.runId, input.callId);

      if (existing === undefined) {
        throw new NotFoundError("approval", input.callId);
      }

      if (existing.status === "pending") {
        const timedOut = await timeoutApproval(database, actor.spaceId, input.runId, input.callId);

        if (timedOut !== undefined) {
          return { record: timedOut, applied: false };
        }

        const settled = await findApproval(database, actor.spaceId, input.runId, input.callId);

        if (settled === undefined) {
          throw new NotFoundError("approval", input.callId);
        }

        return { record: settled, applied: false };
      }

      return { record: existing, applied: false };
    },

    async listForRun(runId: string): Promise<readonly ApprovalRecord[]> {
      const { rows } = await database.query<ApprovalRecord>(
        `select ${approvalColumns} from approval where space_id = $1 and run_id = $2 ` +
          "order by created_at asc, id asc",
        [actor.spaceId, runId],
      );

      return rows;
    },
  };
}

async function findApproval(
  database: Queryable,
  spaceId: string,
  runId: string,
  callId: string,
): Promise<ApprovalRecord | undefined> {
  const { rows } = await database.query<ApprovalRecord>(
    `select ${approvalColumns} from approval ` +
      "where space_id = $1 and run_id = $2 and call_id = $3",
    [spaceId, runId, callId],
  );

  return rows[0];
}

/**
 * The timeout compare-and-set: one statement decides whether the deadline or
 * another writer wins, and `expires_at <= now()` is the server's clock, so a
 * timeout can never fire early.
 */
async function timeoutApproval(
  database: Queryable,
  spaceId: string,
  runId: string,
  callId: string,
): Promise<ApprovalRecord | undefined> {
  const { rows } = await database.query<ApprovalRecord>(
    "update approval set status = 'timed_out'::approval_status, decided_at = now(), " +
      "updated_at = now() " +
      "where space_id = $1 and run_id = $2 and call_id = $3 " +
      "and status = 'pending'::approval_status and expires_at <= now() " +
      `returning ${approvalColumns}`,
    [spaceId, runId, callId],
  );

  return rows[0];
}

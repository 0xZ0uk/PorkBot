import { NotFoundError } from "@porkbot/effect";
import type { RunEventSink } from "@porkbot/effect";
import type { RunEvent } from "@porkbot/core";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { eventColumns } from "./records.ts";
import type { EventRecord } from "./records.ts";

/**
 * The durable half of a run's event stream (slice 5.6), over the `event` table.
 *
 * The append is one statement: the thread's `next_event_seq` counter advances
 * to cover the event's position (`greatest`, so a session that allocated ahead
 * does not move it backwards) and the row is inserted in the same statement,
 * so a failed insert cannot leave a gap in the contiguous sequence a
 * subscription replays from. `(thread_id, seq)` unique makes a second writer
 * at the same position a loud error rather than a silently overwritten event.
 *
 * The statement is scoped like every other data path: the thread must be in
 * the actor's space, the run must be too, and the run must belong to that
 * thread, so a forged or mis-addressed event writes nothing. A thread or run
 * outside the scope is the typed `NotFoundError`; a position already written
 * is a plain error, because two sessions claiming one sequence is a topology
 * bug, not a retry.
 *
 * The base fields live in columns, not in `payload`: the subscriber's
 * reconstruction in `apps/api` reads `seq`, `threadId`, `runId` and `type`
 * from the row and cannot be redirected by a payload. What is stored is the
 * event the recorder produced, redacted and bounded, so the live frame and the
 * replayed one are the same bytes.
 */
export function createRunEventSink(actor: SystemActor, database: Queryable): RunEventSink {
  return {
    async append(event: RunEvent): Promise<void> {
      const { rows } = await database.query<EventRecord>(
        "with allocated as (" +
          "update thread set next_event_seq = greatest(next_event_seq, $3::integer + 1), " +
          "updated_at = now() " +
          "where id = $2 and space_id = $1 and exists (" +
          "select 1 from run r where r.id = $6 and r.space_id = $1 and r.thread_id = $2) " +
          "returning id) " +
          "insert into event (space_id, thread_id, seq, type, payload, run_id) " +
          "select $1, $2, $3::integer, $4, $5::jsonb, $6::uuid from allocated " +
          `returning ${eventColumns}`,
        [actor.spaceId, event.threadId, event.seq, event.type, payloadJson(event), event.runId],
      );

      if (rows.length > 0) {
        return;
      }

      // No row means the thread or the run is outside the actor's space. The
      // scoped read names which, without leaking that either exists elsewhere.
      const { rows: threads } = await database.query<{ readonly id: string }>(
        "select id from thread where id = $1 and space_id = $2",
        [event.threadId, actor.spaceId],
      );

      if (threads.length === 0) {
        throw new NotFoundError("thread", event.threadId);
      }

      throw new NotFoundError("run", event.runId);
    },
  };
}

/** The event minus its base fields, which the row carries as columns. */
function payloadJson(event: RunEvent): string {
  const payload = { ...event } as Record<string, unknown>;
  delete payload["schemaVersion"];
  delete payload["seq"];
  delete payload["threadId"];
  delete payload["runId"];
  delete payload["type"];

  return JSON.stringify(payload);
}

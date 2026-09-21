import type { Queryable } from "./queryable.ts";

/**
 * Addressing for a queued, unowned run. The worker uses this reconciliation
 * read to turn the durable command into a Graphile delivery; it carries no
 * prompt, message content or provider data.
 */
export interface QueuedRunDispatch {
  readonly runId: string;
  readonly spaceId: string;
  readonly fence: number;
}

export const queuedRunDispatchBatchSize = 100;

/**
 * Finds every run that still needs a queue delivery, regardless of whether a
 * message, a routine or the operator created it. A delivery may already exist;
 * its stable Graphile job key makes redispatch idempotent, while this read
 * repairs the gap when a command was committed without one.
 */
export async function findQueuedRunDispatches(
  database: Queryable,
  limit: number = queuedRunDispatchBatchSize,
): Promise<readonly QueuedRunDispatch[]> {
  const { rows } = await database.query<QueuedRunDispatch>(
    'select id as "runId", space_id as "spaceId", lease_fence as "fence" from run ' +
      "where status = 'queued' and lease_owner is null " +
      "order by created_at asc, id asc limit $1",
    [limit],
  );

  return rows;
}

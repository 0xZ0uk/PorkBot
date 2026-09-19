import type {
  ComputerLeaseAcquisition,
  ComputerLeaseHolder,
  ComputerLeaseStore,
} from "@porkbot/effect";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { RUN_LEASE_TTL_SECONDS } from "./run-leases.ts";

/**
 * The computer lease (slice 7.4, PRD decisions 26 and 27).
 *
 * A run's commands reach their machine through `ComputerProvider.exec`, a seam
 * that deliberately carries no fence; this module is the lease above it that
 * decides who may command a computer. One row per held computer, addressed by
 * `bot_id`, bound to the run's own `(run_id, owner, fence)` and to the run's
 * live `lease_expires_at`, so every write here is fenced exactly like a run
 * write: a reclaimed run's holder can neither renew nor commit, and the next
 * owner takes the machine only after the old lease expires.
 *
 * The TTL is the safety margin. `COMPUTER_LEASE_TTL_SECONDS` is the run lease's
 * own TTL — never longer — so the window in which a stale worker can still
 * touch the sandbox is bounded by the window the run lease already allows, and
 * a reclaim cannot leave a tool running under a lease the product has not
 * accounted for. The one comparison of the two values lives at the guard
 * (`createFencedComputerCommands` in `@porkbot/effect`), which refuses to be
 * built with a computer lease longer than the run lease.
 *
 * The statements are the whole concurrency story, one per operation:
 *
 *   - `hold` is an upsert whose conflict arm is fenced on the run's live lease
 *     and whose `where` decides between renewing our own binding, taking an
 *     expired one, and losing to a live foreign holder. No read-then-write.
 *   - `release` deletes only the exact binding it is given, so a released
 *     lease cannot take a newer holder's row with it.
 *   - `findExpiredComputerLeases` is the watchdog's scan. Like
 *     `findExpiredLeases`, it is a deliberate cross-space read that answers
 *     addressing only; every write after it goes through the `SystemActor` its
 *     `spaceId` names.
 */

/**
 * The computer lease's TTL. It is deliberately the run lease's TTL: a computer
 * may not outlive the run that holds it, so a reclaim frees the machine within
 * the same window it frees the run.
 */
export const COMPUTER_LEASE_TTL_SECONDS = RUN_LEASE_TTL_SECONDS;

/**
 * How many stale leases one watchdog pass releases. Ordered oldest-expiry
 * first, like the run scan, so a backlog drains on the next interval instead of
 * holding one job open.
 */
export const COMPUTER_WATCHDOG_BATCH_LIMIT = 50;

/** One expired lease the watchdog may release. Addressing only. */
export interface ExpiredComputerLease extends ComputerLeaseHolder {
  readonly spaceId: string;
  readonly expiresAt: Date;
}

interface HoldRow {
  readonly runHeld: boolean;
  readonly heldBotId: string | null;
  readonly heldRunId: string | null;
  readonly heldOwner: string | null;
  readonly heldFence: number | null;
  readonly heldExpiresAt: Date | null;
  readonly currentExpiresAt: Date | null;
}

/**
 * Acquires the computer for a run, or renews the lease that run already holds.
 *
 * The upsert only writes when the run's own lease is the live row at the
 * supplied fence, so a reclaimed run cannot renew: the `exists` in the conflict
 * arm is the same guard a run write uses. A lease held live by another run is
 * `busy`; an expired one is taken over in the same statement.
 */
export async function holdComputerLease(
  actor: SystemActor,
  database: Queryable,
  holder: ComputerLeaseHolder,
  ttlSeconds: number = COMPUTER_LEASE_TTL_SECONDS,
): Promise<ComputerLeaseAcquisition> {
  // Under read committed, a statement's snapshot does not see a conflicting
  // row another transaction commits while this statement waits on the unique
  // index: the upsert can know it lost the arbiter while the classification
  // read sees no row at all. One more attempt takes a fresh snapshot, where
  // the winner's committed row (or its concurrent delete) is visible; a second
  // miss would mean the row changed twice inside one statement, which no
  // writer here can do.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await holdOnce(actor, database, holder, ttlSeconds);

    if (
      row.heldBotId !== null &&
      row.heldRunId !== null &&
      row.heldOwner !== null &&
      row.heldFence !== null &&
      row.heldExpiresAt !== null
    ) {
      return {
        status: "held",
        lease: {
          botId: row.heldBotId,
          runId: row.heldRunId,
          owner: row.heldOwner,
          fence: row.heldFence,
          expiresAt: row.heldExpiresAt,
        },
      };
    }

    if (!row.runHeld) {
      return { status: "run_lost" };
    }

    if (row.currentExpiresAt !== null) {
      return { status: "busy", expiresAt: row.currentExpiresAt };
    }
  }

  throw new Error("the computer lease could not be classified across two holds");
}

async function holdOnce(
  actor: SystemActor,
  database: Queryable,
  holder: ComputerLeaseHolder,
  ttlSeconds: number,
): Promise<HoldRow> {
  const { rows } = await database.query<HoldRow>(
    "with run_ok as (" +
      "select r.id as run_id, r.space_id, r.bot_id, r.lease_owner, r.lease_fence " +
      "from run r " +
      "where r.id = $3 and r.space_id = $1 and r.bot_id = $2 " +
      "and r.lease_owner = $4 and r.lease_fence = $5 and r.lease_expires_at > now() " +
      "and r.status in ('running', 'waiting_approval')" +
      "), held as (" +
      "insert into computer_lease (space_id, bot_id, run_id, owner, fence, expires_at) " +
      "select run_ok.space_id, run_ok.bot_id, run_ok.run_id, run_ok.lease_owner, " +
      "run_ok.lease_fence, now() + make_interval(secs => $6) from run_ok " +
      "on conflict (bot_id) do update " +
      "set run_id = excluded.run_id, owner = excluded.owner, fence = excluded.fence, " +
      "expires_at = excluded.expires_at, updated_at = now() " +
      // A live foreign holder wins; ours renews, an expired one is replaced,
      // and the run's live lease is required in every case.
      "where (computer_lease.expires_at <= now() " +
      "or (computer_lease.run_id = excluded.run_id and computer_lease.owner = excluded.owner " +
      "and computer_lease.fence = excluded.fence)) " +
      "and exists (select 1 from run_ok) " +
      'returning bot_id as "botId", run_id as "runId", owner, fence, ' +
      'expires_at as "expiresAt"' +
      ") " +
      'select exists (select 1 from run_ok) as "runHeld", ' +
      '(select "botId" from held) as "heldBotId", ' +
      '(select "runId" from held) as "heldRunId", ' +
      '(select owner from held) as "heldOwner", ' +
      '(select fence from held) as "heldFence", ' +
      '(select "expiresAt" from held) as "heldExpiresAt", ' +
      '(select expires_at from computer_lease where bot_id = $2) as "currentExpiresAt"',
    [actor.spaceId, holder.botId, holder.runId, holder.owner, holder.fence, ttlSeconds],
  );

  const row = rows[0];

  if (row === undefined) {
    throw new Error("the computer-lease hold returned no row");
  }

  return row;
}

/**
 * Clears exactly the binding it is given. A settlement releases its own lease;
 * a release that matches nothing — a reclaimed holder, a lease already swept —
 * is a no-op rather than an error, because the work it was guarding is already
 * accounted for.
 */
export async function releaseComputerLease(
  actor: SystemActor,
  database: Queryable,
  holder: ComputerLeaseHolder,
): Promise<boolean> {
  const { rows } = await database.query<{ readonly id: string }>(
    "delete from computer_lease " +
      "where space_id = $1 and bot_id = $2 and run_id = $3 and owner = $4 and fence = $5 " +
      "returning id",
    [actor.spaceId, holder.botId, holder.runId, holder.owner, holder.fence],
  );

  return rows.length > 0;
}

/**
 * The watchdog's scan: every computer lease whose TTL has elapsed, oldest
 * expiry first. Addressing only, and the same deliberate cross-space exception
 * `findExpiredLeases` documents: a stale lease is found before the actor that
 * would scope it, and every follow-up write goes through the `SystemActor` the
 * row's `spaceId` names.
 */
export async function findExpiredComputerLeases(
  database: Queryable,
  limit: number = COMPUTER_WATCHDOG_BATCH_LIMIT,
): Promise<readonly ExpiredComputerLease[]> {
  const { rows } = await database.query<ExpiredComputerLease>(
    'select space_id as "spaceId", bot_id as "botId", run_id as "runId", owner, fence, ' +
      'expires_at as "expiresAt" from computer_lease ' +
      "where expires_at <= now() order by expires_at asc, id asc limit $1",
    [limit],
  );

  return rows;
}

/**
 * The store the fenced command runner takes: this module's statements behind
 * the `ComputerLeaseStore` seam in `@porkbot/effect`, bound to one job's space
 * like every other repository. The watchdog's scan is deliberately not part of
 * it — that one starts from rows, not an actor — and is exported beside it for
 * the same reason `findExpiredLeases` is.
 */
export function createComputerLeaseStore(
  actor: SystemActor,
  database: Queryable,
): ComputerLeaseStore {
  return {
    hold: (holder, ttlSeconds) => holdComputerLease(actor, database, holder, ttlSeconds),
    release: (holder) => releaseComputerLease(actor, database, holder),
  };
}

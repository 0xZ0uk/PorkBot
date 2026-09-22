/**
 * The deployment's connection budget (slice 14.6).
 *
 * `deploy/compose.yaml` starts Postgres with `max_connections = 32` and
 * `superuser_reserved_connections = 3`; this register is the application half
 * of the same budget. Every pool a shipped process opens names one of these
 * entries, so the sum of the caps is the deployment's worst-case backend
 * count and the headroom is what the server keeps free on purpose.
 *
 * A pool cap and the server limit are one fact, so
 * `connection-budget.test.ts` reads both and fails when either moves without
 * the other. The memory half of the budget — `shared_buffers`, `work_mem`,
 * `maintenance_work_mem` and the Postgres 18 I/O settings — is named on the
 * same server command and stated beside the ceiling in
 * `docs/architecture/operations.md`.
 */
export const databaseConnections = {
  /** The server's `max_connections`; the deployment names the same number. */
  maxConnections: 32,
  /**
   * The slots Postgres reserves for superusers. The operator's `psql` and the
   * deployment's administrative statements connect as the owner, so they use
   * this reserve rather than a pool's cap.
   */
  superuserReserved: 3,
  /**
   * How many jobs the worker runs at once. The queue pool is sized from it, so
   * the two move together rather than a pool cap being inherited from a
   * driver default.
   */
  workerJobConcurrency: 4,
  /**
   * The worst-case simultaneous backends each named pool may hold. The caps
   * are per process, not per request: a process that opens no connection
   * holds none, and a pool only ever opens what its work needs.
   *
   *   - `api`: the API borrows one connection per statement and returns it,
   *     so five is already more than one Node process has in flight.
   *   - `workerQueue`: the Graphile runner's own pool, sized to
   *     `workerJobConcurrency` (4) plus the two connections its bookkeeping
   *     needs.
   *   - `workerReadiness`: the worker's `/readyz` probe and the run-dispatch
   *     scan it shares the handle with — one statement at a time.
   *   - `backup`: the backup process's long-lived handle, where the ledger
   *     write and the status read can be open at once.
   *   - `backupTools`: the drill's administrative handle plus the `pg_dump`
   *     or `pg_restore` child it runs beside — one child at a time.
   *   - `migrate`: the one-shot migrator, one connection.
   */
  pools: {
    api: 5,
    workerQueue: 6,
    workerReadiness: 1,
    backup: 2,
    backupTools: 2,
    migrate: 1,
  },
  /**
   * The slots the budget deliberately leaves unused: room for a second
   * operator session, a diagnostic connection and the deployment's own
   * ad-hoc statements, so a pool at its cap never makes the operator wait.
   * Stated as a number so a change to any pool has to say what it does to the
   * headroom.
   */
  headroom: 12,
} as const;

/** A named pool in the budget; every `openDatabase` caller picks one. */
export type DatabasePool = keyof typeof databaseConnections.pools;

/** The connection cap for one named pool. */
export function poolConnectionLimit(pool: DatabasePool): number {
  return databaseConnections.pools[pool];
}

/** The worst-case backends the named pools can hold at once. */
export function pooledConnections(): number {
  return Object.values(databaseConnections.pools).reduce((total, cap) => total + cap, 0);
}

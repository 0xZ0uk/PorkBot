/**
 * The shared typed-error vocabulary the transport boundary maps from (PRD
 * decision 28). Errors live here rather than beside the code that throws them,
 * because `@porkbot/effect` owns the one `Cause -> ORPCError` table and must be
 * able to name every error it maps without importing a data layer.
 *
 * Nothing here carries secret material or an operator-visible hint: a typed
 * error is a fact the caller already had, not a diagnostic.
 */

/**
 * A resource the caller asked for does not exist *in the caller's scope*. The
 * two cases — "no such row" and "a row in another space" — deliberately produce
 * the same error, so a response can never confirm that a guessed id exists
 * somewhere else (PRD decision 7).
 */
export class NotFoundError extends Error {
  readonly resource: string;
  readonly id: string;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = "NotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

/**
 * The deployment configuration disagrees with itself: the settings table holds
 * more than one row, so "are signups open?" has no single answer. Fail-closed
 * ownership (PRD decision 8) means the resolution must be an explicit
 * misconfiguration surfaced to the operator, never a coin flip between rows,
 * and never a silently-open deployment.
 */
export class DeploymentSettingsConflictError extends Error {
  readonly rows: number;

  constructor(rows: number) {
    super(
      `deployment_settings holds ${rows} rows; exactly one configuration is expected. ` +
        "Remove the extra rows and keep the one the operator wrote.",
    );
    this.name = "DeploymentSettingsConflictError";
    this.rows = rows;
  }
}

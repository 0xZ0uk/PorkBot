import { resolveDeploymentSettings } from "@porkbot/core";
import type { DeploymentSettings } from "@porkbot/core";
import { DeploymentSettingsConflictError } from "@porkbot/effect";
import type { PostgresDatabase } from "./database.ts";
import { deploymentSettings } from "./schema/tenancy.ts";

/**
 * The one reader of the deployment's settings row.
 *
 * This is the deliberate exception to actor-scoped data access: the signup gate
 * must decide whether a deployment is open *before* a user, a session or a
 * membership exists, so there is no actor to scope by. The read takes no tenant
 * id and returns no tenant data — one row of deployment configuration — and it
 * resolves "no row" to `null` rather than to a default, because the fail-closed
 * policy in `@porkbot/core` treats absence as "signups closed" only when the
 * caller passes it no settings at all.
 *
 * `resolveDeploymentSettings` owns the meaning of the rows: absent, one
 * configuration, or a conflict. A conflict throws instead of picking a row,
 * because two disagreeing rows are a misconfiguration the operator must see
 * (PRD decision 8) and because a gate that guesses is a gate that can guess
 * "open".
 */
export async function readDeploymentSettings(
  database: PostgresDatabase,
): Promise<DeploymentSettings | null> {
  const rows = await database
    .select({
      signupsEnabled: deploymentSettings.signupsEnabled,
      adminEmail: deploymentSettings.adminEmail,
    })
    .from(deploymentSettings);

  const resolution = resolveDeploymentSettings(rows);

  if (resolution.kind === "conflict") {
    throw new DeploymentSettingsConflictError(resolution.rows);
  }

  return resolution.kind === "configured" ? resolution.settings : null;
}

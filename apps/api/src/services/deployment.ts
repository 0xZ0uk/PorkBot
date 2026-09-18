import type { DeploymentSettings } from "@porkbot/core";
import { DeploymentSettingsConflictError } from "@porkbot/effect";

/**
 * The deployment service: what the transport asks when a client needs to know
 * whether this deployment accepts signups.
 *
 * The service owns the translation, not the transport. `readDeploymentSettings`
 * throws on a conflicting configuration because the auth gate must fail closed;
 * a status query has a third honest answer — "misconfigured" — so the service
 * turns that one domain error into an outcome and lets everything else throw.
 * The router then maps the outcome to output or to the contract's typed error
 * without ever inspecting a raw error (PRD decisions 8 and 28).
 */

/** The three facts a status query can return. */
export type DeploymentStatus =
  { readonly kind: "open" } | { readonly kind: "closed" } | { readonly kind: "misconfigured" };

/** The read the service performs; injected so tests need no database. */
export type SignupSettingsReader = () => Promise<DeploymentSettings | null>;

export interface DeploymentStatusService {
  status(): Promise<DeploymentStatus>;
}

export function createDeploymentStatusService(
  readSettings: SignupSettingsReader,
): DeploymentStatusService {
  return {
    async status(): Promise<DeploymentStatus> {
      try {
        const settings = await readSettings();

        // Fail closed: only an explicit `true` opens the deployment, exactly as
        // `decideSignup` in @porkbot/core decides it.
        return settings?.signupsEnabled === true ? { kind: "open" } : { kind: "closed" };
      } catch (error) {
        if (error instanceof DeploymentSettingsConflictError) {
          return { kind: "misconfigured" };
        }

        throw error;
      }
    },
  };
}

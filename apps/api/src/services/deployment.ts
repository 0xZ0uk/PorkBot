import type { DeploymentSettings } from "@porkbot/core";
import { DeploymentSettingsConflictError } from "@porkbot/effect";

/**
 * The deployment service: the deployment settings a screen may read.
 *
 * `status` answers whether this deployment accepts signups; `ownership`
 * answers who owns it (slice 11.5). The service owns the translation, not the
 * transport. `readDeploymentSettings` throws on a conflicting configuration
 * because the auth gate must fail closed; both reads have a third honest
 * answer — "misconfigured" — so the service turns that one domain error into
 * an outcome and lets everything else throw. The routers then map the outcome
 * to output or to the contract's typed error without ever inspecting a raw
 * error (PRD decisions 8 and 28).
 */

/** The three facts a status query can return. */
export type DeploymentStatus =
  { readonly kind: "open" } | { readonly kind: "closed" } | { readonly kind: "misconfigured" };

/**
 * The ownership read's outcome. `configured` carries the admin address the
 * settings name, or `null` when the operator never set one; `misconfigured`
 * is a settings table that disagrees with itself, where "who owns this
 * deployment?" has no single answer.
 */
export type DeploymentOwnership =
  | { readonly kind: "configured"; readonly ownerEmail: string | null }
  | { readonly kind: "misconfigured" };

/** The read the service performs; injected so tests need no database. */
export type SignupSettingsReader = () => Promise<DeploymentSettings | null>;

export interface DeploymentService {
  status(): Promise<DeploymentStatus>;
  ownership(): Promise<DeploymentOwnership>;
}

export function createDeploymentService(readSettings: SignupSettingsReader): DeploymentService {
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

    async ownership(): Promise<DeploymentOwnership> {
      try {
        const settings = await readSettings();

        return { kind: "configured", ownerEmail: settings?.adminEmail ?? null };
      } catch (error) {
        // A conflict has a third honest answer here: ownership has no single
        // answer, and `null` would claim the deployment has no owner.
        if (error instanceof DeploymentSettingsConflictError) {
          return { kind: "misconfigured" };
        }

        throw error;
      }
    },
  };
}

/**
 * Fail-closed signup and ownership policy.
 *
 * PRD decision 8: a deployment refuses every signup unless its settings
 * explicitly say otherwise, and ownership is only ever assigned to the
 * configured admin email. The first registrant inherits nothing: with no
 * settings there is no signup at all, and with signups open but no explicit
 * admin email every registration is a member, never an owner.
 *
 * The policy reads a snapshot — the values, not a database handle — so the
 * auth gate can call it with whatever the settings row currently holds, and a
 * missing row is a first-class input rather than an error.
 */

export interface DeploymentSettings {
  readonly signupsEnabled: boolean;
  readonly adminEmail: string | null;
}

export type SignupRole = "owner" | "member";

export type SignupDecision =
  | { readonly ok: true; readonly role: SignupRole }
  | { readonly ok: false; readonly reason: "signups_closed" | "invalid_email" };

/** The one comparison rule for email addresses: trimmed, case-insensitive. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether an address is the configured admin's. An absent, empty or
 * whitespace-only admin email is not an explicit one, so it never matches.
 */
export function isOwnerEmail(email: string, adminEmail: string | null | undefined): boolean {
  if (adminEmail === null || adminEmail === undefined) {
    return false;
  }

  const configured = normalizeEmail(adminEmail);
  if (configured.length === 0) {
    return false;
  }

  return normalizeEmail(email) === configured;
}

/**
 * Decides one registration attempt; this is the gate, not a helper beside one.
 * Only an explicit `signupsEnabled: true` opens the door — no settings row,
 * `false`, or a value a caller forgot to set is closed — and an absent or
 * blank address can never become a member.
 */
export function decideSignup(
  email: string,
  settings?: DeploymentSettings | null | undefined,
): SignupDecision {
  if (settings === null || settings === undefined || settings.signupsEnabled !== true) {
    return { ok: false, reason: "signups_closed" };
  }

  if (typeof email !== "string" || email.trim().length === 0) {
    return { ok: false, reason: "invalid_email" };
  }

  return {
    ok: true,
    role: isOwnerEmail(email, settings.adminEmail) ? "owner" : "member",
  };
}

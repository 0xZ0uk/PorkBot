import type { MemberRole } from "@porkbot/contracts";
import { roleLabel } from "../ownership.ts";

/**
 * The account surface (slice 11.5): the actor's role and this deployment's
 * configured owner.
 *
 * Two facts, both of them state rather than settings: the role is the
 * membership the gate resolved, and the owner is the address the deployment
 * named at bootstrap. A deployment with no configured owner says so — an empty
 * row would invite "maybe I configured it" — and the copy does not imply the
 * signed-in actor is or is not that owner, because both roles see this page.
 */

export interface AccountScreenProps {
  readonly role: MemberRole;
  readonly ownerEmail: string | null;
}

export function AccountScreen({ role, ownerEmail }: AccountScreenProps) {
  return (
    <section className="console">
      <h2>Account</h2>
      <dl className="connection-details">
        <dt>Your role</dt>
        <dd>{roleLabel(role)}</dd>
        <dt>Deployment owner</dt>
        <dd>
          {ownerEmail === null ? (
            <span className="muted">No owner configured</span>
          ) : (
            <span className="connection-credential">{ownerEmail}</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

import type { MemberRole } from "@porkbot/contracts";

/**
 * The account settings surface's data (slice 11.5): who the actor is and who
 * owns the deployment it acts in. The read has no state machine — the route
 * loader awaits it and the router's error component answers a refusal — so
 * this module owns the transport's shape and the words for the two facts, and
 * nothing else.
 */
export interface OwnershipTransport {
  ownership(): Promise<{ readonly role: MemberRole; readonly ownerEmail: string | null }>;
}

/** The role as words; `memberRoleSchema`'s closed set, exhaustively mapped. */
export function roleLabel(role: MemberRole): string {
  return role === "owner" ? "Owner" : "Member";
}

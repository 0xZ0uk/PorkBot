import type { SpaceMemberRole, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { insertedRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The single-operator bootstrap: where a registration becomes a membership.
 *
 * Slice 3.1's auth gate admits a registration and reports it through
 * `onSignup({ userId, email, role })`; this command is the half that gives the
 * new user a tenant. It is deliberately not actor-scoped — no actor exists
 * before the membership does — and it is the only write path in this package
 * that is not built from an `Actor`. It takes a user id and a role, never a
 * space id, so the caller cannot choose which space a signup lands in, and it
 * returns the `UserActor` the membership resolves to, which is the scope every
 * later repository call is built from.
 *
 * v1.0 is one operator, one space. Exactly-once is structural rather than a
 * promise:
 *
 *   - Every bootstrap opens by taking one transaction-scoped advisory lock, so
 *     concurrent signups serialize here. `space` has no key a duplicate could
 *     conflict on, so the lock — not a unique index — is what makes the
 *     read-then-insert below create exactly one space.
 *   - `space_member_space_user_unique` makes a replay of the same user a no-op
 *     at the database, and the replay returns the first role: running the
 *     bootstrap twice writes nothing.
 *   - `space_member_owner_unique` admits one owner per space, so a second
 *     registration cannot become a second owner even if the deployment's admin
 *     email changed between the two. A late owner request joins as a member
 *     instead of failing after Better Auth has already written the user row;
 *     the bootstrap can lose someone ownership, never grant it (the same
 *     direction as `decideSignup`).
 *
 * There is no invitation path and no role-management function in this module
 * or anywhere in v1.0 (PRD, Out of Scope): the signup policy is the only
 * source of a role, the first role stands, and nothing here updates an
 * existing membership. Multi-tenancy later is more spaces and more
 * memberships, not a migration — this command just stops being the only row
 * creator.
 *
 * `database` must be one connection for the duration of the call — a
 * `pg.Client`, or a client checked out of a pool and released afterwards —
 * because the transaction and the advisory lock only span work that travels on
 * the same connection. A failure after Better Auth has written the user row
 * leaves a repairable state rather than a broken one: running this command
 * again for the same user id creates the membership that is missing, which is
 * the repair `create-auth.ts` points at. The API wires it into `onSignup` when
 * the transport slice lands; the seam and the command are this slice's half.
 */

/**
 * The name the operator's space is created under. v1.0 has no screen that asks
 * for one; renaming is a UI concern for the multi-tenant slices, so the value
 * is a constant rather than an untested option.
 */
export const defaultSpaceName = "My space";

/**
 * An advisory-lock key unique to this path (0x506f726b, "Pork"), namespacing
 * the lock against every other advisory lock a future slice may take. The lock
 * only has to be stable across processes, not meaningful.
 */
const bootstrapLockKey = 1_349_481_067;

/**
 * What the auth layer admitted. The role is the one `decideSignup` decided;
 * the bootstrap may lower it to `member`, never raise it.
 */
export interface BootstrapInput {
  readonly userId: string;
  readonly role: SpaceMemberRole;
}

/**
 * The result of one bootstrap. `createdSpace` and `createdMembership` are false
 * on a replay, which is how a caller can log the first run differently from the
 * repair run without inspecting rows.
 */
export interface BootstrapResult {
  readonly actor: UserActor;
  readonly createdSpace: boolean;
  readonly createdMembership: boolean;
}

export async function bootstrapSignup(
  database: Queryable,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return withTransaction(database, async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock($1)", [bootstrapLockKey]);

    const { spaceId, createdSpace } = await resolveSpace(transaction);
    const existingRole = await readMembershipRole(transaction, spaceId, input.userId);

    if (existingRole !== undefined) {
      // A replay of the same registration: the first role stands and nothing
      // is written.
      return {
        actor: actorFor(spaceId, input.userId, existingRole),
        createdSpace,
        createdMembership: false,
      };
    }

    const role =
      input.role === "owner" && (await hasOwner(transaction, spaceId)) ? "member" : input.role;
    const insertedRole = await insertMembership(transaction, spaceId, input.userId, role);

    return {
      actor: actorFor(spaceId, input.userId, insertedRole),
      createdSpace,
      createdMembership: true,
    };
  });
}

/**
 * The deployment's one space, created by whichever signup arrives first. The
 * caller holds the bootstrap lock, so a read that finds no row is the only
 * path that inserts and two concurrent bootstraps cannot both find none.
 */
async function resolveSpace(
  transaction: Queryable,
): Promise<{ readonly spaceId: string; readonly createdSpace: boolean }> {
  const { rows } = await transaction.query<{ readonly id: string }>(
    "select id from space order by created_at asc, id asc limit 1",
  );

  const existing = rows[0];
  if (existing !== undefined) {
    return { spaceId: existing.id, createdSpace: false };
  }

  const { rows: inserted } = await transaction.query<{ readonly id: string }>(
    "insert into space (name) values ($1) returning id",
    [defaultSpaceName],
  );

  return { spaceId: insertedRow(inserted).id, createdSpace: true };
}

async function readMembershipRole(
  transaction: Queryable,
  spaceId: string,
  userId: string,
): Promise<SpaceMemberRole | undefined> {
  const { rows } = await transaction.query<{ readonly role: SpaceMemberRole }>(
    "select role from space_member where space_id = $1 and user_id = $2",
    [spaceId, userId],
  );

  return rows[0]?.role;
}

async function hasOwner(transaction: Queryable, spaceId: string): Promise<boolean> {
  const { rows } = await transaction.query<{ readonly one: number }>(
    "select 1 as one from space_member where space_id = $1 and role = 'owner' limit 1",
    [spaceId],
  );

  return rows.length > 0;
}

async function insertMembership(
  transaction: Queryable,
  spaceId: string,
  userId: string,
  role: SpaceMemberRole,
): Promise<SpaceMemberRole> {
  const { rows } = await transaction.query<{ readonly role: SpaceMemberRole }>(
    "insert into space_member (space_id, user_id, role) values ($1, $2, $3) returning role",
    [spaceId, userId, role],
  );

  return insertedRow(rows).role;
}

function actorFor(spaceId: string, userId: string, role: SpaceMemberRole): UserActor {
  return { kind: "user", spaceId, userId, role };
}

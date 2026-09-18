import { randomUUID } from "node:crypto";
import { NOTIFICATION_KINDS } from "@porkbot/core";
import type { NotificationKind } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { createIngressStore, openDatabase, resolveUserActor } from "../../../src/index.ts";
import type { DatabaseHandle, IngressStore } from "../../../src/index.ts";
import * as schema from "../../../src/schema/index.ts";
import { memberSubject, mountSpace, resources, systemSubject, userSubject } from "./matrix.ts";
import type { Resource, SpaceHandle } from "./matrix.ts";

/**
 * The authorization matrix (slice 3.3): actor × space × resource, on a real
 * Postgres, through the seams shipped code uses.
 *
 * The register in `./matrix` names every space-scoped entity and gives each a
 * read and a write probe. This spec runs each probe in two directions — the
 * actor against its own space and against another space — and asserts the
 * cross-space answer is the shared `NOT_FOUND` (or the empty answer the seam
 * uses for it) with the foreign rows left untouched. Job handlers are covered
 * through the system-actor probes, the transport surfaces by the suites beside
 * this one (`apps/api/src/stream.test.ts`, `apps/api/src/webhooks.test.ts`,
 * `apps/worker/test/integration/worker.integration.test.ts`), and the tables
 * that are deliberately not space-scoped are named as exemptions below with
 * their reason.
 *
 * The coverage test is the part that keeps this honest as the schema grows: it
 * reads every table from the Drizzle schema and fails when a table is not in a
 * probed entry, an explicit suite, or the exemption list — so a new entity
 * without a matrix entry cannot merge.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
let handle: DatabaseHandle | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_authorization_matrix" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
  handle = openDatabase(suite.connectionString);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await handle?.close();
  await suite?.destroy();
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

function drizzle(): DatabaseHandle {
  if (handle === undefined) {
    throw new Error("the suite's handle was not created; the beforeAll hook failed first");
  }

  return handle;
}

/**
 * One suite per registered resource: the same probes, run against the acting
 * space and against another one. The suite mounts exactly two spaces, and every
 * test seeds the rows it acts on, so a one-shot write — a run claim, a routine
 * fire — is fresh for the cross-space attempt instead of consumed by the
 * in-space control. The refusal can then only come from the scope, never from
 * a state the control test already changed.
 */
function defineResourceSuite(entry: Resource<unknown>): void {
  describe(`resource: ${entry.entity}`, () => {
    let acting: SpaceHandle;
    let foreign: SpaceHandle;

    beforeAll(async () => {
      const database = db();
      acting = await mountSpace(database, `acting ${entry.entity}`);
      foreign = await mountSpace(database, `foreign ${entry.entity}`);
    });

    const user = entry.user;

    if (user?.read !== undefined) {
      it("reads inside its own space", async () => {
        const seed = await entry.seed(acting);

        await expect(user.read?.(userSubject(acting), seed)).resolves.toBe("visible");
      });

      it("cannot read another space's rows", async () => {
        const seed = await entry.seed(foreign);

        await expect(user.read?.(userSubject(acting), seed)).resolves.toBe("refused");
      });

      if (user.sharedInSpace === false) {
        it("keeps the row private to the user who owns it", async () => {
          const seed = await entry.seed(acting);

          await expect(user.read?.(memberSubject(acting), seed)).resolves.toBe("refused");
        });
      }
    }

    if (user?.write !== undefined) {
      it("writes inside its own space", async () => {
        const seed = await entry.seed(acting);

        await expect(user.write?.(userSubject(acting), seed)).resolves.toBe("applied");
      });

      it("cannot write another space's rows, and changes nothing", async () => {
        const seed = await entry.seed(foreign);
        const before = await entry.state(foreign, seed);

        await expect(user.write?.(userSubject(acting), seed)).resolves.toBe("refused");
        await expect(entry.state(foreign, seed)).resolves.toBe(before);
      });
    }

    const system = entry.system;

    if (system?.read !== undefined) {
      it("lets a job read its own space", async () => {
        const seed = await entry.seed(acting);

        await expect(system.read?.(systemSubject(acting), seed)).resolves.toBe("visible");
      });

      it("cannot read another space's rows with a system actor", async () => {
        const seed = await entry.seed(acting);

        await expect(system.read?.(systemSubject(foreign), seed)).resolves.toBe("refused");
      });
    }

    if (system?.write !== undefined) {
      it("lets a job write its own space", async () => {
        const seed = await entry.seed(acting);

        await expect(system.write?.(systemSubject(acting), seed)).resolves.toBe("applied");
      });

      it("cannot write another space's rows with a system actor, and changes nothing", async () => {
        const seed = await entry.seed(acting);
        const before = await entry.state(acting, seed);

        await expect(system.write?.(systemSubject(foreign), seed)).resolves.toBe("refused");
        await expect(entry.state(acting, seed)).resolves.toBe(before);
      });
    }
  });
}

/**
 * The preference table is not targetable: no method takes a user or space id,
 * so there is no foreign row to address and the cross-space assertion is
 * non-interference plus the delivery path's scoped eligibility answer.
 */
function defineNotificationSuite(): void {
  describe("resource: notification_preference", () => {
    let acting: SpaceHandle;
    let other: SpaceHandle;
    const kind: NotificationKind = NOTIFICATION_KINDS[0] ?? "run.completed";

    beforeAll(async () => {
      const database = db();
      acting = await mountSpace(database, "notifications acting");
      other = await mountSpace(database, "notifications other");
    });

    it("writes only the actor's own switch and leaves another space's switch alone", async () => {
      const before = await other.ownerRepositories.notifications.read();

      await acting.ownerRepositories.notifications.set(kind, true);

      expect((await acting.ownerRepositories.notifications.read())[kind]).toBe(true);
      expect((await other.ownerRepositories.notifications.read())[kind]).toBe(false);
      expect(await other.ownerRepositories.notifications.read()).toEqual(before);
    });

    it("answers the delivery path's eligibility from the job's space", async () => {
      await expect(
        acting.systemRepositories.notifications.eligibility(acting.owner.userId, kind),
      ).resolves.toBe("enabled");
      await expect(
        other.systemRepositories.notifications.eligibility(acting.owner.userId, kind),
      ).resolves.toBe("not_a_recipient");
    });

    it("refuses a switch once the membership is revoked", async () => {
      const revoked = await mountSpace(db(), "notifications revoked");

      await db().query("delete from space_member where space_id = $1 and user_id = $2", [
        revoked.spaceId,
        revoked.owner.userId,
      ]);

      await expect(revoked.ownerRepositories.notifications.set(kind, true)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
}

/**
 * Credentials are addressed by a name inside the actor's own space, never by a
 * row id, so there is no foreign row to address: the same name in another space
 * is a different row. The cross-space assertions are therefore
 * non-interference — another space's names never appear in a list or resolve,
 * and storing the same name leaves the other row's ciphertext alone.
 */
function defineCredentialSuite(): void {
  describe("resource: encrypted_credential", () => {
    let acting: SpaceHandle;
    let other: SpaceHandle;

    beforeAll(async () => {
      const database = db();
      acting = await mountSpace(database, "credentials acting");
      other = await mountSpace(database, "credentials other");
    });

    it("stores and resolves only the actor's own space", async () => {
      const name = `matrix-${randomUUID()}`;

      await acting.credentials.store(name, "acting-secret");
      await other.credentials.store(name, "other-secret");

      // The same name is a different row per space, and each space's job
      // resolves its own ciphertext.
      await expect(acting.credentials.resolve(name)).resolves.toBe("acting-secret");
      await expect(acting.systemCredentials.resolve(name)).resolves.toBe("acting-secret");
      await expect(other.systemCredentials.resolve(name)).resolves.toBe("other-secret");
    });

    it("omits another space's names from list and resolve", async () => {
      const name = `matrix-${randomUUID()}`;
      await other.credentials.store(name, "other-secret");

      expect((await acting.credentials.list()).map((row) => row.name)).not.toContain(name);
      await expect(acting.systemCredentials.resolve(name)).resolves.toBeUndefined();
    });

    it("stores a name without disturbing another space's row of the same name", async () => {
      const name = `matrix-${randomUUID()}`;
      await other.credentials.store(name, "other-secret");

      await acting.credentials.store(name, "acting-replacement");

      await expect(other.systemCredentials.resolve(name)).resolves.toBe("other-secret");
      await expect(acting.systemCredentials.resolve(name)).resolves.toBe("acting-replacement");
    });
  });
}

/**
 * The OAuth state is a pre-actor ingress ledger: it is issued from an actor
 * and consumed with no actor at all. The cross-space property is the binding —
 * another space cannot rebind the same bearer value, and the consumer gets the
 * issuer's space and user, never the presenter's.
 */
function defineOAuthStateSuite(): void {
  describe("resource: oauth_state", () => {
    let acting: SpaceHandle;
    let other: SpaceHandle;
    let ingress: IngressStore;

    beforeAll(async () => {
      const database = db();
      acting = await mountSpace(database, "oauth acting");
      other = await mountSpace(database, "oauth other");
      ingress = createIngressStore(drizzle().database);
    });

    it("binds a state to its issuing actor and refuses a rebind from another space", async () => {
      const state = `matrix-${randomUUID()}`;

      await expect(ingress.issue({ actor: acting.owner, state })).resolves.toBe(true);
      await expect(ingress.issue({ actor: other.owner, state })).resolves.toBe(false);

      await expect(ingress.consume(state)).resolves.toEqual({
        spaceId: acting.spaceId,
        userId: acting.owner.userId,
      });
      // Spent: the bearer value cannot be replayed, whoever presents it.
      await expect(ingress.consume(state)).resolves.toBeUndefined();
    });
  });
}

/**
 * The membership is the authorization root itself. It has no actor-facing
 * writes (bootstrap owns them, before an actor exists), so the matrix asserts
 * the two reads that matter: the live re-check the subscription loop uses, and
 * the session resolver the gate uses. The consequence for an open stream is
 * locked by `apps/api/src/stream.test.ts`.
 */
function defineMembershipSuite(): void {
  describe("resource: space_member", () => {
    let space: SpaceHandle;

    beforeAll(async () => {
      space = await mountSpace(db(), "membership");
    });

    it("re-reads a live membership", async () => {
      await expect(space.ownerRepositories.membership.requireActive()).resolves.toBeUndefined();
      await expect(space.memberRepositories.membership.requireActive()).resolves.toBeUndefined();
    });

    it("refuses the live check once the membership is revoked", async () => {
      await revoke(space.spaceId, space.owner.userId);

      await expect(space.ownerRepositories.membership.requireActive()).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("stops resolving into an actor once the membership is revoked", async () => {
      const revoked = await mountSpace(db(), "membership resolution");

      await expect(
        resolveUserActor(drizzle().database, { userId: revoked.owner.userId }),
      ).resolves.toMatchObject({ spaceId: revoked.spaceId, userId: revoked.owner.userId });

      await revoke(revoked.spaceId, revoked.owner.userId);

      await expect(
        resolveUserActor(drizzle().database, { userId: revoked.owner.userId }),
      ).resolves.toBeNull();
    });
  });
}

async function revoke(spaceId: string, userId: string): Promise<void> {
  await db().query("delete from space_member where space_id = $1 and user_id = $2", [
    spaceId,
    userId,
  ]);
}

const explicitSuites = new Map<string, () => void>([
  ["encrypted_credential", defineCredentialSuite],
  ["notification_preference", defineNotificationSuite],
  ["oauth_state", defineOAuthStateSuite],
  ["space_member", defineMembershipSuite],
]);

/**
 * The harness's own migration ledger lives in `public` beside the domain
 * tables; it is test infrastructure, not a resource.
 */
const harnessTables: ReadonlySet<string> = new Set(["testkit_migrations"]);

/**
 * Tables the matrix deliberately does not probe, each with why. These are the
 * deployment-global and pre-actor rows: they carry no space predicate because
 * they are not tenant data, and a matrix entry would have to invent an actor
 * that does not exist at their call sites.
 */
const exemptTables: readonly { readonly table: string; readonly reason: string }[] = [
  {
    table: "user",
    reason: "global identity, owned by Better Auth; there is no actor-scoped seam",
  },
  {
    table: "session",
    reason: "global identity, owned by Better Auth; read only by the gate's resolver",
  },
  {
    table: "account",
    reason: "global identity, owned by Better Auth; there is no actor-scoped seam",
  },
  {
    table: "verification",
    reason: "global identity, owned by Better Auth; there is no actor-scoped seam",
  },
  {
    table: "space",
    reason: "the tenancy root, written by bootstrapSignup before any actor exists",
  },
  {
    table: "deployment_settings",
    reason: "deployment-global configuration, read before an actor can exist",
  },
  {
    table: "webhook_delivery",
    reason: "deployment-global ingress dedupe keyed by (source, delivery_id); not tenant data",
  },
];

describe("the authorization matrix", () => {
  for (const entry of resources) {
    defineResourceSuite(entry);
  }

  for (const define of explicitSuites.values()) {
    define();
  }

  describe("coverage of the resource list", () => {
    const exportedTables = Object.values(schema)
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table))
      .sort();

    /**
     * The tables the migrated database actually has, not the ones the schema
     * module happens to export: `pg_catalog` is the authority the repository
     * already trusts for its schema rules, and it catches a migration that
     * ships beside a missing export.
     */
    async function migratedTables(): Promise<readonly string[]> {
      const { rows } = await db().query<{ readonly table: string }>(
        "select tablename as table from pg_catalog.pg_tables " +
          "where schemaname = 'public' order by tablename",
      );

      return rows.map((row) => row.table).filter((table) => !harnessTables.has(table));
    }

    it("keeps the schema module and the migrated database in step", async () => {
      // A smoke test on the walk itself: if the schema module's exports change
      // shape, or a migration lands without an export, the coverage test must
      // fail loudly rather than pass vacuously.
      expect(exportedTables.length).toBeGreaterThan(20);
      expect(exportedTables).toContain("bot");
      expect(exportedTables).toContain("run");
      await expect(migratedTables()).resolves.toEqual(exportedTables);
    });

    it("names every migrated table in a probed entry, an explicit suite or an exemption", async () => {
      const migrated = await migratedTables();
      const probed = new Set(resources.flatMap((entry) => entry.tables));
      const explicit = new Set(explicitSuites.keys());
      const exempt = new Map(exemptTables.map((entry) => [entry.table, entry.reason]));

      for (const [table, reason] of exempt) {
        expect(reason.trim(), `${table} needs a one-line reason`).not.toBe("");
      }

      const known = new Set([...probed, ...explicit, ...exempt.keys()]);
      const missing = migrated.filter((table) => !known.has(table));
      const stale = [...known].filter((table) => !migrated.includes(table));

      expect(missing, "a table ships with no authorization test").toEqual([]);
      expect(stale, "the matrix names a table the schema does not have").toEqual([]);
    });
  });
});

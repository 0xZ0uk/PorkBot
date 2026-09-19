import {
  MAX_BOT_SECRET_VALUE_LENGTH,
  parseBotSecretAuth,
  parseBotSecretDestination,
  sameBotSecretDestination,
} from "@porkbot/core";
import type { BotSecretAuth, BotSecretDestination } from "@porkbot/core";
import { BotSecretDestinationError, CredentialStoreError, NotFoundError } from "@porkbot/effect";
import type {
  BotSecretRequests,
  BotSecretResolver,
  BotSecrets,
  BotSecretSummary,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import {
  credentialEnvelopeKeyId,
  decryptCredentialValue,
  encryptCredentialValue,
} from "./credential-cipher.ts";
import type { CredentialKeyring } from "./credential-cipher.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of bot secrets (slice 9.6, E9 epic; reference parity
 * BotSecret), over the `bot_secret` rows.
 *
 * This is the one module that names those rows, and
 * `bot-secret-store.call-sites.test.ts` walks the shipped source and fails when
 * the table name appears anywhere else — the same ownership the credential,
 * memory and notification stores have. Values are encrypted on the way in and
 * decrypted only by `resolve`, which the run's credential-proxy composition
 * calls; every other read answers metadata and a status.
 *
 * The factory splits by actor as the other stores do:
 *
 *   - A `SystemActor` receives `BotSecretRequests & BotSecretResolver`: the
 *     metadata reads and forget the agent's tools ask for, plus the one
 *     server-side resolve the proxy handle injects. Nothing here lets a tool
 *     hold a value — the resolver is a separate interface the tool options do
 *     not name.
 *   - A `UserActor` receives `BotSecrets`: list, find, put a value beside its
 *     destination, forget and rotate, every statement bound to the actor's
 *     `space_id` and to a bot that belongs to it.
 *
 * A cross-space bot id is the shared `NotFoundError` before any row is read or
 * written, so the same answer covers "no such bot" and "a bot in another
 * space". A store built without a keyring is locked: `resolve`, `put` and
 * `rotate` raise the typed `CredentialStoreError` with reason `locked`, while
 * `list`, `find` and `forget` keep working so an operator can clean up.
 */

interface StoredBotSecretRow {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly auth: unknown;
  readonly envelope: string | null;
  readonly forgottenAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const secretColumns =
  'id, name, origin, auth, envelope, forgotten_at as "forgottenAt", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

function requireKeyring(keyring: CredentialKeyring | undefined): CredentialKeyring {
  if (keyring === undefined) {
    throw new CredentialStoreError("locked");
  }

  return keyring;
}

/**
 * The authentication half of a row. Writes are validated before insert, so a
 * row this cannot parse is a database-level tamper rather than caller input;
 * the error names no part of the stored value.
 */
function requireAuth(auth: unknown): BotSecretAuth {
  const parsed = parseBotSecretAuth(auth);

  if (parsed === undefined) {
    throw new Error("a bot secret row carries an authentication shape this build cannot use");
  }

  return parsed;
}

function toSummary(row: StoredBotSecretRow): BotSecretSummary {
  return {
    name: row.name,
    status: row.envelope === null ? "forgotten" : "stored",
    origin: row.origin,
    auth: requireAuth(row.auth),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBotSecretStore(
  actor: SystemActor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): BotSecretRequests & BotSecretResolver;
export function createBotSecretStore(
  actor: UserActor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): BotSecrets;
export function createBotSecretStore(
  actor: Actor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): (BotSecretRequests & BotSecretResolver) | BotSecrets;
export function createBotSecretStore(
  actor: Actor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): (BotSecretRequests & BotSecretResolver) | BotSecrets {
  /** A bot id outside the actor's space is the same not-found as a missing one. */
  async function requireBot(botId: string): Promise<void> {
    const { rows } = await database.query<{ readonly id: string }>(
      "select id from bot where space_id = $1 and id = $2",
      [actor.spaceId, botId],
    );

    if (rows.length === 0) {
      throw new NotFoundError("bot", botId);
    }
  }

  async function list(botId: string): Promise<readonly BotSecretSummary[]> {
    await requireBot(botId);
    const { rows } = await database.query<StoredBotSecretRow>(
      `select ${secretColumns} from bot_secret ` +
        "where space_id = $1 and bot_id = $2 order by name asc",
      [actor.spaceId, botId],
    );

    return rows.map(toSummary);
  }

  async function find(botId: string, name: string): Promise<BotSecretSummary | undefined> {
    await requireBot(botId);
    const { rows } = await database.query<StoredBotSecretRow>(
      `select ${secretColumns} from bot_secret ` +
        "where space_id = $1 and bot_id = $2 and name = $3",
      [actor.spaceId, botId, name],
    );
    const row = rows[0];

    return row === undefined ? undefined : toSummary(row);
  }

  async function forget(botId: string, name: string): Promise<{ readonly removed: boolean }> {
    await requireBot(botId);
    // Nulling the ciphertext is the removal; the row, its destination and its
    // timestamp stay as the audit line a list renders. A row already forgotten
    // matches nothing, which is the idempotent no-op answer.
    const { rows } = await database.query<{ readonly id: string }>(
      "update bot_secret set envelope = null, forgotten_at = now(), updated_at = now() " +
        "where space_id = $1 and bot_id = $2 and name = $3 and envelope is not null " +
        "returning id",
      [actor.spaceId, botId, name],
    );

    return { removed: rows.length > 0 };
  }

  if (actor.kind === "system") {
    const resolve: BotSecretResolver["resolve"] = async (botId, name) => {
      const keys = requireKeyring(keyring);
      await requireBot(botId);
      const { rows } = await database.query<{
        readonly origin: string;
        readonly auth: unknown;
        readonly envelope: string | null;
      }>(
        "select origin, auth, envelope from bot_secret " +
          "where space_id = $1 and bot_id = $2 and name = $3",
        [actor.spaceId, botId, name],
      );
      const row = rows[0];

      if (row === undefined || row.envelope === null) {
        return undefined;
      }

      return {
        destination: {
          name,
          origin: row.origin,
          auth: requireAuth(row.auth),
        },
        value: decryptCredentialValue(keys, { spaceId: actor.spaceId, botId, name }, row.envelope),
      };
    };

    return { list, find, forget, resolve };
  }

  const put = async (
    botId: string,
    destination: BotSecretDestination,
    value: string,
  ): Promise<BotSecretSummary> => {
    const keys = requireKeyring(keyring);
    const parsed = parseBotSecretDestination(destination);

    if (!parsed.ok) {
      throw new Error(`a bot secret destination was refused: ${parsed.reason}`);
    }

    // A blank secret is not a secret: storing one would let an origin
    // authenticate as an empty string. The message names no value.
    if (value.trim() === "") {
      throw new Error("a bot secret needs a non-blank value");
    }

    if (value.length > MAX_BOT_SECRET_VALUE_LENGTH) {
      throw new Error(
        `a bot secret value must be at most ${MAX_BOT_SECRET_VALUE_LENGTH} characters`,
      );
    }

    await requireBot(botId);
    const { rows: existingRows } = await database.query<{
      readonly origin: string;
      readonly auth: unknown;
      readonly envelope: string | null;
    }>(
      "select origin, auth, envelope from bot_secret where space_id = $1 and bot_id = $2 and name = $3",
      [actor.spaceId, botId, parsed.value.name],
    );
    const existing = existingRows[0];

    // A value already held is bound to its origin and authentication; a write
    // that would re-point it is refused rather than silently redirected. A
    // forgotten row holds no value, so its destination may be rewritten. The
    // read and the upsert are two statements, so two concurrent writes with
    // different destinations can both pass this check; the tool boundary
    // re-reads the destination after an approval resolves, so a race can never
    // send an approved value to an origin the operator did not see.
    if (
      existing !== undefined &&
      existing.envelope !== null &&
      !sameBotSecretDestination(
        { name: parsed.value.name, origin: existing.origin, auth: requireAuth(existing.auth) },
        parsed.value,
      )
    ) {
      throw new BotSecretDestinationError(parsed.value.name);
    }

    const envelope = encryptCredentialValue(
      keys,
      { spaceId: actor.spaceId, botId, name: parsed.value.name },
      value,
    );
    const { rows } = await database.query<StoredBotSecretRow>(
      "insert into bot_secret (space_id, bot_id, name, origin, auth, envelope) " +
        "values ($1, $2, $3, $4, $5::jsonb, $6) " +
        "on conflict (space_id, bot_id, name) do update " +
        "set origin = excluded.origin, auth = excluded.auth, envelope = excluded.envelope, " +
        "forgotten_at = null, updated_at = now() " +
        `returning ${secretColumns}`,
      [
        actor.spaceId,
        botId,
        parsed.value.name,
        parsed.value.origin,
        JSON.stringify(parsed.value.auth),
        envelope,
      ],
    );
    const row = rows[0];

    if (row === undefined) {
      throw new Error("the bot secret write returned no row");
    }

    return toSummary(row);
  };

  const rotate = async () => {
    const keys = requireKeyring(keyring);
    const { rows } = await database.query<{
      readonly id: string;
      readonly botId: string;
      readonly name: string;
      readonly envelope: string;
    }>(
      'select id, bot_id as "botId", name, envelope from bot_secret ' +
        "where space_id = $1 and envelope is not null order by name asc",
      [actor.spaceId],
    );
    let reencrypted = 0;

    for (const row of rows) {
      if (credentialEnvelopeKeyId(row.envelope) === keys.activeKeyId) {
        continue;
      }

      const value = decryptCredentialValue(
        keys,
        { spaceId: actor.spaceId, botId: row.botId, name: row.name },
        row.envelope,
      );
      const envelope = encryptCredentialValue(
        keys,
        { spaceId: actor.spaceId, botId: row.botId, name: row.name },
        value,
      );

      await database.query(
        "update bot_secret set envelope = $1, updated_at = now() where id = $2 and space_id = $3",
        [envelope, row.id, actor.spaceId],
      );
      reencrypted += 1;
    }

    return { activeKeyId: keys.activeKeyId, reencrypted, total: rows.length };
  };

  return { list, find, put, forget, rotate };
}

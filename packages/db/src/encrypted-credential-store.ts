import type { CredentialStore } from "@porkbot/adapter-kit";
import { CredentialStoreError } from "@porkbot/effect";
import type { CredentialRotation, CredentialSummary, Credentials } from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import {
  credentialEnvelopeKeyId,
  decryptCredentialValue,
  encryptCredentialValue,
  maskCredentialValue,
} from "./credential-cipher.ts";
import type { CredentialKeyring } from "./credential-cipher.ts";
import type { Queryable } from "./queryable.ts";
import { insertedRow } from "./rows.ts";

/**
 * The durable half of stored credentials (slice 9.1, PRD decision 10; stories
 * 14 and 15), over the `encrypted_credential` rows.
 *
 * This is the one module that names the encrypted credential rows, and
 * `encrypted-credential-store.call-sites.test.ts` walks the shipped source and
 * fails when the table name appears anywhere else — the same ownership the
 * memory and notification stores have. Every value is encrypted on the way in
 * and decrypted on the way out through `credential-cipher.ts`; the store never
 * returns a value except from `resolve`, and `list` answers summaries whose
 * only value-derived field is a four-character mask.
 *
 * The factory splits by actor as the other stores do:
 *
 *   - A `SystemActor` receives `CredentialStore`: `resolve(name)` through the
 *     job payload's space, and nothing that enumerates or writes.
 *   - A `UserActor` receives `Credentials`: the same resolve plus `list`,
 *     `store` and `rotate`, every statement bound to the actor's `space_id`.
 *
 * A store built without a keyring is locked: every call raises the typed
 * `CredentialStoreError` with reason `locked` before it touches the database,
 * so a deployment that forgot its keys fails loudly instead of reading rows it
 * cannot authenticate.
 */

interface StoredCredentialRow {
  readonly id: string;
  readonly name: string;
  readonly envelope: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const credentialColumns =
  'id, name, envelope, created_at as "createdAt", updated_at as "updatedAt"';

function requireKeyring(keyring: CredentialKeyring | undefined): CredentialKeyring {
  if (keyring === undefined) {
    throw new CredentialStoreError("locked");
  }

  return keyring;
}

export function createEncryptedCredentialStore(
  actor: SystemActor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): CredentialStore;
export function createEncryptedCredentialStore(
  actor: UserActor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): Credentials;
export function createEncryptedCredentialStore(
  actor: Actor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): Credentials | CredentialStore;
export function createEncryptedCredentialStore(
  actor: Actor,
  database: Queryable,
  keyring?: CredentialKeyring | undefined,
): Credentials | CredentialStore {
  const resolve = async (name: string): Promise<string | undefined> => {
    const keys = requireKeyring(keyring);
    const { rows } = await database.query<{ readonly envelope: string }>(
      "select envelope from encrypted_credential where space_id = $1 and name = $2",
      [actor.spaceId, name],
    );
    const envelope = rows[0]?.envelope;

    if (envelope === undefined) {
      return undefined;
    }

    return decryptCredentialValue(keys, { spaceId: actor.spaceId, name }, envelope);
  };

  if (actor.kind === "system") {
    return { resolve };
  }

  return {
    resolve,

    async list(): Promise<readonly CredentialSummary[]> {
      const keys = requireKeyring(keyring);
      const { rows } = await database.query<StoredCredentialRow>(
        `select ${credentialColumns} from encrypted_credential ` +
          "where space_id = $1 order by name asc",
        [actor.spaceId],
      );

      // A row that cannot be decrypted fails the whole list rather than being
      // skipped: a list that silently hides a credential is how an operator
      // rotates the wrong one.
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        maskedValue: maskCredentialValue(
          decryptCredentialValue(keys, { spaceId: actor.spaceId, name: row.name }, row.envelope),
        ),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    async store(name: string, value: string): Promise<CredentialSummary> {
      const keys = requireKeyring(keyring);

      // A blank secret is not a secret: storing one would let a provider
      // authenticate as an empty string, the same failure the environment
      // store avoids by treating a blank variable as absent. The message names
      // neither argument.
      if (name.trim() === "" || value.trim() === "") {
        throw new Error("a credential needs a non-blank name and value");
      }

      const envelope = encryptCredentialValue(keys, { spaceId: actor.spaceId, name }, value);
      const { rows } = await database.query<StoredCredentialRow>(
        `insert into encrypted_credential (space_id, name, envelope) values ($1, $2, $3) ` +
          "on conflict (space_id, name) do update " +
          "set envelope = excluded.envelope, updated_at = now() " +
          `returning ${credentialColumns}`,
        [actor.spaceId, name, envelope],
      );
      const row = insertedRow(rows);

      return {
        id: row.id,
        name: row.name,
        // The caller already holds the value it just wrote; the mask is
        // computed from it rather than by decrypting the row back.
        maskedValue: maskCredentialValue(value),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async remove(name: string): Promise<void> {
      // Deleting needs no keyring: the row is addressed by its scoped name and
      // nothing is decrypted, so an operator can clean up after a missing key
      // instead of being locked out of both reading and removing the row.
      await database.query("delete from encrypted_credential where space_id = $1 and name = $2", [
        actor.spaceId,
        name,
      ]);
    },

    async rotate(): Promise<CredentialRotation> {
      // One pass per row, not one transaction for all of them: a credential
      // written mid-rotation is caught by the next pass, and a row already on
      // the active key is left alone rather than rewritten.
      const keys = requireKeyring(keyring);
      const { rows } = await database.query<StoredCredentialRow>(
        `select ${credentialColumns} from encrypted_credential ` +
          "where space_id = $1 order by name asc",
        [actor.spaceId],
      );
      let reencrypted = 0;

      for (const row of rows) {
        if (credentialEnvelopeKeyId(row.envelope) === keys.activeKeyId) {
          continue;
        }

        const value = decryptCredentialValue(
          keys,
          { spaceId: actor.spaceId, name: row.name },
          row.envelope,
        );
        const envelope = encryptCredentialValue(
          keys,
          { spaceId: actor.spaceId, name: row.name },
          value,
        );

        await database.query(
          "update encrypted_credential set envelope = $1, updated_at = now() " +
            "where id = $2 and space_id = $3",
          [envelope, row.id, actor.spaceId],
        );
        reencrypted += 1;
      }

      return { activeKeyId: keys.activeKeyId, reencrypted, total: rows.length };
    },
  };
}

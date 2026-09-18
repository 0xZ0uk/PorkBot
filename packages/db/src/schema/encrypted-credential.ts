import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { space } from "./tenancy.ts";

/**
 * Encrypted credentials (slice 9.1, PRD decision 10; stories 14 and 15).
 *
 * A row is a named secret: `name` is what a provider resolves (`model-key`, a
 * webhook's signing secret), and `envelope` is the AES-256-GCM ciphertext the
 * cipher writes, carrying its key id, salt, IV and authentication tag. The
 * value is never a column, so no query, list response or log line can return
 * it by selecting a little too much.
 *
 * `(space_id, name)` is unique because that pair is the row's identity in
 * every read and in the additional authenticated data the cipher binds to: an
 * envelope copied into another row — another name, or the same name in another
 * space — fails authentication rather than decrypting into the wrong
 * credential. A rename is therefore a re-encryption, not an update; nothing in
 * v1 renames one.
 *
 * The envelope is text rather than bytea because its parts are base64url text
 * and the format is versioned (`v1:<key id>:<salt>:<iv>:<tag>:<ciphertext>`);
 * the schema stores what the cipher produces without a second encoding to
 * drift from. `space_id` cascades with the space: a deleted space leaves no
 * ciphertext behind.
 */
export const encryptedCredential = pgTable(
  "encrypted_credential",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    envelope: text("envelope").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("encrypted_credential_space_name_unique").on(table.spaceId, table.name),
    index("encrypted_credential_space_id_idx").on(table.spaceId),
    check("encrypted_credential_name_check", sql`length(btrim(${table.name})) > 0`),
    check("encrypted_credential_envelope_check", sql`length(btrim(${table.envelope})) > 0`),
  ],
);

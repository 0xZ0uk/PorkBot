import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { space } from "./tenancy.ts";

/**
 * Model connections (slice 9.2, PRD decisions 12, 13 and 19; stories 12 and 13).
 *
 * A connection is the generic way to reach a model endpoint: a base URL and
 * the *name* of the stored credential that opens it. The key itself is never a
 * column here — it lives encrypted in the credential store under
 * `(space_id, credential_name)` — so no query, list response or log line can
 * return it, and a provider resolves it by name through the credential seam.
 * The shape is deliberately vendor-neutral: a hosted provider and a
 * self-hosted OpenAI-compatible server are the same row with a different URL,
 * and no provider-specific column or environment variable exists.
 *
 * `label` is the operator's name for the connection, unique per space so a
 * settings list is unambiguous. `default_model` is the model the Space uses
 * when it has no other preference; a bot's own `model` overrides it, which is
 * what makes "model selection is per bot with a space default" a pair of
 * columns rather than a convention.
 *
 * `is_default` names the one connection a bot without its own selection uses.
 * The partial unique index admits exactly one default per space, so the
 * fallback is a database answer rather than a coin flip between two rows; a
 * space with no default and a bot with no connection is "no model selected",
 * which the run executor reports rather than guessing. Delete cascades with
 * the space; deleting a connection leaves its bots' `model_connection_id` null
 * (the column's `on delete set null`), which is the same "no selection" state.
 *
 * `last_used_at` is nullable because "never used" is a real answer. It is
 * stamped by the API whenever a request leaves for the connection — the probe
 * today, and the run executor's model selection when that integration lands —
 * so the settings list can say which endpoint is actually in service. Only
 * `porkbot_api` may write it; the worker's grant stays SELECT, so a job cannot
 * move the timestamp of the connection it uses.
 *
 * The checks are structural rather than decorative: a blank label or
 * credential name is not a name, a base URL must be http(s) and must not embed
 * credentials (the URL-safety module and the credential store own those
 * respectively), and a blank default model is not a model.
 */
export const modelConnection = pgTable(
  "model_connection",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    credentialName: text("credential_name").notNull(),
    defaultModel: text("default_model"),
    isDefault: boolean("is_default").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("model_connection_space_label_unique").on(table.spaceId, table.label),
    uniqueIndex("model_connection_space_default_unique")
      .on(table.spaceId)
      .where(sql`${table.isDefault}`),
    index("model_connection_space_id_idx").on(table.spaceId),
    check("model_connection_label_check", sql`length(btrim(${table.label})) > 0`),
    check(
      "model_connection_credential_name_check",
      sql`length(btrim(${table.credentialName})) > 0`,
    ),
    check("model_connection_base_url_scheme_check", sql`${table.baseUrl} ~ '^https?://'`),
    check("model_connection_base_url_no_credentials_check", sql`${table.baseUrl} !~ '://[^/?#]*@'`),
    check(
      "model_connection_default_model_check",
      sql`${table.defaultModel} is null or length(btrim(${table.defaultModel})) > 0`,
    ),
  ],
);

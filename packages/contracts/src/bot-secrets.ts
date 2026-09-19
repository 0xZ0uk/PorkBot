import {
  BOT_SECRET_NAME_PATTERN,
  BOT_SECRET_STATUSES,
  isBotSecretOrigin,
  MAX_BOT_SECRET_USERNAME_LENGTH,
  MAX_BOT_SECRET_VALUE_LENGTH,
  parseBotSecretAuth,
} from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * A bot's stored secrets (slice 9.6, E9 epic; reference parity BotSecret).
 *
 * A bot secret is a named credential an operator stores for one bot: a value,
 * the one bare HTTPS origin it may be sent to, and how it authenticates. The
 * agent never reads the value through any surface here — `list` answers names,
 * destinations and statuses, `put` takes a value and answers the row without
 * one, and `remove` clears the value and reports whether one was cleared. There
 * is deliberately no field on an output schema that carries the value, its
 * ciphertext or a value-derived mask, so "a list endpoint never returns a
 * secret" is a property of the wire shape rather than a promise about a
 * handler.
 *
 * A write that re-points an existing value at another origin or another
 * authentication is the contract's typed `CONFLICT`: the value is bound to the
 * destination the operator stored it for, and changing that destination is a
 * forget followed by a fresh store.
 */

export const botSecretStatusSchema = z.enum(BOT_SECRET_STATUSES);

/**
 * The three authentication modes. The union's shape is the wire contract; the
 * refine hands the authority to `@porkbot/core`, which owns the header rules a
 * request may not rewrite (framing, hop-by-hop and the proxy's own header).
 */
export const botSecretAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("bearer") }),
    z.object({
      type: z.literal("header"),
      name: z.string().min(1).max(120),
    }),
    z.object({
      type: z.literal("basic"),
      username: z.string().min(1).max(MAX_BOT_SECRET_USERNAME_LENGTH),
    }),
  ])
  .refine((auth) => parseBotSecretAuth(auth) !== undefined, {
    message: "The credential cannot authenticate with that configuration",
  });

export type BotSecretAuthView = z.infer<typeof botSecretAuthSchema>;

export const botSecretOriginSchema = z.string().max(2_048).refine(isBotSecretOrigin, {
  message: "Expected an HTTPS origin with no path, query, fragment or credentials",
});

export const botSecretSchema = z.object({
  /** The name an ask, a list and a proxy upstream are addressed by. */
  name: z.string().min(1),
  /** `stored` while a value is held; `forgotten` once it was cleared. */
  status: botSecretStatusSchema,
  /** The one HTTPS origin the value may be sent to, and no other. */
  origin: z.string().min(1),
  auth: botSecretAuthSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type BotSecretView = z.infer<typeof botSecretSchema>;

const botId = z.uuid();
const name = z.string().regex(BOT_SECRET_NAME_PATTERN, {
  message: "Expected a lowercase identifier of letters, digits and underscores",
});
const notFound = {
  NOT_FOUND: {
    status: 404,
    message: "No such bot in this space",
  },
};

export const botSecretsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/secrets",
    operationId: "botSecretsList",
    summary: "List a bot's stored secrets by name, destination and status",
  })
  .input(z.object({ botId }))
  .errors({
    ...notFound,
    /** The keyring cannot unlock a row; only the operator can repair it. */
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The credential store is not readable",
    },
  })
  .output(z.object({ secrets: z.array(botSecretSchema) }));

export const botSecretsPutContract = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/bots/{botId}/secrets/{name}",
    operationId: "botSecretsPut",
    summary: "Store or replace one bot secret beside its one destination",
  })
  .input(
    z.object({
      botId,
      name,
      /**
       * The secret. The request body cap bounds it before it is parsed; this
       * bound is the schema's own, large enough for a long key and small enough
       * that a mistake is refused rather than stored.
       */
      value: z.string().min(1).max(MAX_BOT_SECRET_VALUE_LENGTH),
      origin: botSecretOriginSchema,
      auth: botSecretAuthSchema,
    }),
  )
  .errors({
    ...notFound,
    /**
     * The name already holds a value for another destination. The value is
     * bound to the origin it was stored for; a re-point is a forget first.
     */
    CONFLICT: {
      status: 409,
      message: "That credential is already stored for another destination",
    },
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The credential store is not readable",
    },
  })
  .output(botSecretSchema);

export const botSecretsRemoveContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/bots/{botId}/secrets/{name}",
    operationId: "botSecretsRemove",
    summary: "Forget one bot secret; the value is cleared immediately",
  })
  .input(z.object({ botId, name }))
  .errors(notFound)
  .output(
    z.object({
      name: z.string().min(1),
      /** False when the row held no value to clear, which makes a retry a no-op. */
      removed: z.boolean(),
    }),
  );

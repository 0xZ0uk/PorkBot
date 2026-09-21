import {
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_DOCUMENT_ID_LENGTH,
  MAX_MEMORY_REASON_LENGTH,
  MAX_MEMORY_TITLE_LENGTH,
  MEMORY_KINDS,
  MEMORY_WRITE_ORIGINS,
} from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The memory module (slice 8.3, PRD decision 21; stories 23 and 24): the
 * operator's read, edit, delete and restore over the durable documents slice
 * 8.1 landed, so wrong memory is correctable in the product rather than only
 * behind the agent's tools.
 *
 * The transport is row-shaped and audit-shaped. `list` answers live documents
 * by default and tombstoned ones under an explicit `deleted` scope, because a
 * deleted document stays registered until an operator decides otherwise;
 * `revisions` is the whole history, oldest first, with each change's who, why,
 * kind and instant, so the surface can show what changed and when rather than
 * only the current state. `update`, `remove` and `restore` return the outcome
 * union: an effective change carries the revision the store persisted, a
 * no-op repeats the current state without growing history, and a refusal names
 * the domain rule it broke — the same shape the agent's tools read, so one
 * surface does not invent a second reading of a memory decision.
 *
 * There is deliberately no `create` here. Memory is written by the bot and by
 * the operator correcting it; inventing a document from the settings surface
 * is a different act with a different rule surface, and it waits until it is
 * needed.
 *
 * Every input names a bot and a document, never a space: the actor-scoped
 * store binds the space, a foreign document is an empty history or a typed
 * refusal, and no response can confirm that a guessed id exists elsewhere (PRD
 * decision 7). The bounds are the ones `@porkbot/core` enforces, so the wire
 * refuses an oversized payload before a store call and the rule refuses it
 * identically for the agent path.
 */

export const memoryKindSchema = z.enum(MEMORY_KINDS);

export const memoryWriteOriginSchema = z.enum(MEMORY_WRITE_ORIGINS);

/**
 * A document as the operator's list reads it. `deletedAt` is null for a live
 * document and the tombstone instant for one under the `deleted` scope, so one
 * shape serves both scopes and the client tells them apart without a second
 * endpoint. The `lastChanged*` fields are the revision the document's
 * `revision` points at — the same who, when and origin the history holds — so
 * the list can name the last change without reading every document's history.
 */
export const memoryDocumentSchema = z.object({
  documentId: z.string().min(1),
  kind: memoryKindSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  /** The live revision number; for a tombstone, the revision that removed it. */
  revision: z.number().int().min(1),
  deletedAt: z.iso.datetime().nullable(),
  lastChangedOrigin: memoryWriteOriginSchema,
  lastChangedBy: z.string().min(1),
  lastChangedAt: z.iso.datetime(),
});

export type MemoryDocumentView = z.infer<typeof memoryDocumentSchema>;

/**
 * One recorded change, whole: the state at the time, who made it, why, and
 * when. `author` is the operator's id or the bot's id; the surface labels the
 * origin rather than printing a raw identifier.
 */
export const memoryRevisionSchema = z.object({
  documentId: z.string().min(1),
  revision: z.number().int().min(1),
  origin: memoryWriteOriginSchema,
  author: z.string().min(1),
  reason: z.string().min(1),
  kind: memoryKindSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  deleted: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type MemoryRevisionView = z.infer<typeof memoryRevisionSchema>;

/**
 * What became of a write or a restore. An effective change carries the
 * persisted revision; `no_change` means the request repeated the document's
 * current state and persisted nothing; a refusal names the domain rule and its
 * sentence, both of which are safe for a client to render.
 *
 * It is a plain union rather than a discriminated one on `ok`: both success
 * members are `ok: true`, so `ok` is not a discriminator and `action` is the
 * field a client narrows on.
 */
export const memoryWriteOutcomeSchema = z.union([
  z.object({
    ok: z.literal(true),
    action: z.enum(["create", "update", "delete", "restore"]),
    revision: memoryRevisionSchema,
  }),
  z.object({
    ok: z.literal(true),
    action: z.literal("no_change"),
  }),
  z.object({
    ok: z.literal(false),
    /** The `MemoryRuleError` class name, e.g. `UnknownMemoryRevision`. */
    rule: z.string().min(1),
    message: z.string().min(1),
  }),
]);

export type MemoryWriteOutcomeView = z.infer<typeof memoryWriteOutcomeSchema>;

/** Which documents a list includes; live by default, tombstones on request. */
export const memoryListScopeSchema = z.enum(["active", "deleted"]);

const documentIdSchema = z.string().min(1).max(MAX_MEMORY_DOCUMENT_ID_LENGTH);
const reasonSchema = z.string().min(1).max(MAX_MEMORY_REASON_LENGTH);

export const memoryListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/memory",
    operationId: "memoryList",
    summary: "A bot's memory documents, live by default and tombstones on request",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      scope: memoryListScopeSchema.default("active"),
    }),
  )
  .output(z.object({ documents: z.array(memoryDocumentSchema) }));

export const memoryRevisionsContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/memory/{documentId}/revisions",
    operationId: "memoryRevisions",
    summary: "One document's whole history, oldest first",
  })
  .input(z.object({ botId: z.string().min(1), documentId: documentIdSchema }))
  .output(z.object({ revisions: z.array(memoryRevisionSchema) }));

export const memoryUpdateContract = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/bots/{botId}/memory/{documentId}",
    operationId: "memoryUpdate",
    summary: "Correct a document, recording who changed it and why",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      documentId: documentIdSchema,
      title: z.string().min(1).max(MAX_MEMORY_TITLE_LENGTH),
      content: z.string().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
      reason: reasonSchema,
    }),
  )
  .output(memoryWriteOutcomeSchema);

export const memoryRemoveContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/bots/{botId}/memory/{documentId}",
    operationId: "memoryRemove",
    summary: "Tombstone a document, keeping its history and its id",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      documentId: documentIdSchema,
      reason: reasonSchema,
    }),
  )
  .output(memoryWriteOutcomeSchema);

export const memoryRestoreContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/memory/{documentId}/restore",
    operationId: "memoryRestore",
    summary: "Reapply one recorded revision, reversing a deletion when it names the tombstone",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      documentId: documentIdSchema,
      revision: z.number().int().min(1),
      reason: reasonSchema,
    }),
  )
  .output(memoryWriteOutcomeSchema);

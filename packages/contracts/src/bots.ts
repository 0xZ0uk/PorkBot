import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The bot module: the operator's teammates, and the actions that create, edit,
 * file, archive and delete them.
 *
 * Every procedure is the by-id shape the gate exists for. The input names a bot
 * (or, for a create, a bot section) and never a space: the repository bound to
 * the actor's space is what reads or writes, so an id from another space and an
 * id that does not exist answer the same typed `NOT_FOUND` and a response can
 * never confirm that a guessed id exists elsewhere (PRD decision 7). The output
 * omits `spaceId` and `userId` for the same reason: the caller already knows
 * the scope it is acting in, and a response is not a place to repeat it.
 *
 * Archived bots are out of the default list, not gone: `bots.list` defaults to
 * `active` and an explicit `archived` or `all` scope asks for the rest, so the
 * restore screen is a scope rather than a second endpoint. Deletion is the hard
 * one, and its rule is stated in the router and the repository: the bot row and
 * everything that dangles from it (its threads, tasks, runs and steering
 * messages) are deleted, its avatar object is deleted through the storage seam,
 * and the computer and home directory it may have are deliberately retained
 * until the slices that own them (E7) define their lifecycle.
 *
 * Avatars travel through the storage seam and nowhere else. The bytes are
 * uploaded as base64 in `bots.setAvatar` — the RPC body cap bounds the
 * request, and `maxAvatarBytes` bounds the avatar inside it — the bot row keeps
 * only the storage key, and `bots.avatar` reads the same key back. No endpoint
 * hands out a filesystem path or a provider URL, so a deployment on local
 * storage and one on S3 answer the same way.
 */

/** The image types an avatar may be: what a browser renders without a plugin. */
export const avatarContentTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type AvatarContentType = (typeof avatarContentTypes)[number];

/** The largest avatar, before base64 encoding, that an upload may carry. */
export const maxAvatarBytes = 512 * 1024;

/**
 * The base64 length of {@link maxAvatarBytes}. Base64 uses four characters per
 * three bytes, so the bound is exact and a payload over it is refused by the
 * schema before anything decodes it.
 */
export const maxAvatarBase64Length = Math.ceil(maxAvatarBytes / 3) * 4;

export const botSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  color: z.string(),
  pinned: z.boolean(),
  position: z.number().int(),
  sectionId: z.string().nullable(),
  /** The storage key of the avatar object; `null` when there is none. */
  avatarKey: z.string().nullable(),
  /**
   * The assigned computer. Opaque until the `computer` table lands with epic
   * E7, which turns this into a reference the read can resolve.
   */
  computerId: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Bot = z.infer<typeof botSchema>;

export const botSectionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type BotSection = z.infer<typeof botSectionSchema>;

/**
 * Which archived state a list includes. `active` is the default because an
 * archived bot is out of the way until it is explicitly asked for.
 */
export const botListScopeSchema = z.enum(["active", "archived", "all"]);

export const botsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots",
    operationId: "botsList",
    summary: "The actor's bots, active by default",
  })
  .input(z.object({ scope: botListScopeSchema.default("active") }))
  .output(z.object({ bots: z.array(botSchema) }));

export const botsCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots",
    operationId: "botsCreate",
    summary: "Create a bot, idempotent on its spawn key",
  })
  .input(
    z.object({
      name: z.string().min(1).max(200),
      color: z.string().min(1).max(64),
      /**
       * The caller's idempotency key. A resubmitted create returns the bot the
       * key already names instead of a second one, so a retried request is a
       * replay.
       */
      spawnKey: z.uuid(),
      title: z.string().max(200).optional(),
      description: z.string().max(4_000).optional(),
      instructions: z.string().max(100_000).optional(),
      pinned: z.boolean().optional(),
      position: z.number().int().min(0).optional(),
      sectionId: z.uuid().nullable().optional(),
      computerId: z.uuid().nullable().optional(),
    }),
  )
  .errors({
    /**
     * The section named by the input is not in the actor's space. A missing
     * section and one in another space are intentionally indistinguishable.
     */
    NOT_FOUND: {
      status: 404,
      message: "No such bot section in this space",
    },
  })
  .output(botSchema);

export const botsUpdateContract = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/bots/{id}",
    operationId: "botsUpdate",
    summary: "Edit a bot's mutable fields",
  })
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(4_000).optional(),
      instructions: z.string().max(100_000).optional(),
      color: z.string().min(1).max(64).optional(),
      pinned: z.boolean().optional(),
      position: z.number().int().min(0).optional(),
      /** `null` unfiles the bot; a section outside the space is not found. */
      sectionId: z.uuid().nullable().optional(),
      /** `null` clears the assignment. */
      computerId: z.uuid().nullable().optional(),
    }),
  )
  .errors({
    /** No such bot, or no such section, in the actor's space. */
    NOT_FOUND: {
      status: 404,
      message: "No such bot or bot section in this space",
    },
  })
  .output(botSchema);

export const botsArchiveContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{id}/archive",
    operationId: "botsArchive",
    summary: "Archive a bot; reversible with restore",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

export const botsRestoreContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{id}/restore",
    operationId: "botsRestore",
    summary: "Restore an archived bot",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

export const botsDeleteContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/bots/{id}",
    operationId: "botsDelete",
    summary: "Delete a bot and its conversations; its home is retained",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

/**
 * The avatar upload body. Exported so the bound is testable at the schema the
 * wire validates against, not at a copy of it: the base64 length is checked
 * before anything decodes, so an oversized payload costs a rejected request
 * rather than an allocation.
 */
export const botAvatarUploadSchema = z.object({
  id: z.string().min(1),
  contentType: z.enum(avatarContentTypes),
  /** The image as base64; bounded before it is decoded. */
  data: z.base64().min(1).max(maxAvatarBase64Length),
});

export const botsSetAvatarContract = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/bots/{id}/avatar",
    operationId: "botsSetAvatar",
    summary: "Upload a bot's avatar through the storage seam",
  })
  .input(botAvatarUploadSchema)
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

export const botsAvatarContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{id}/avatar",
    operationId: "botsAvatar",
    summary: "Read a bot's avatar from the storage seam",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    /** No such bot in this space, or no avatar stored for it. */
    NOT_FOUND: {
      status: 404,
      message: "No avatar for this bot in this space",
    },
  })
  .output(
    z.object({
      contentType: z.string().min(1),
      data: z.string(),
    }),
  );

export const botsClearAvatarContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/bots/{id}/avatar",
    operationId: "botsClearAvatar",
    summary: "Remove a bot's avatar from the storage seam",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

export const botsGetContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{id}",
    operationId: "botsGet",
    summary: "One bot in the actor's space",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    /**
     * No such bot *in the actor's space*. A missing id and an id from another
     * space are intentionally indistinguishable.
     */
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(botSchema);

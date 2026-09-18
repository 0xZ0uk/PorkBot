import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";
import { botSectionSchema } from "./bots.ts";

/**
 * Bot sections: the named groups the operator files bots under.
 *
 * A section's name is unique per space and user, so creating or renaming one
 * onto a name that is taken is the contract's typed `CONFLICT` rather than a
 * database error that reaches the client as a 500. Every read and write is
 * actor-scoped like the bots module: the input names a section, never a space,
 * and a section in another space is the same `NOT_FOUND` a missing one gets.
 * The scope is the pair — a section belongs to the user who named it, and the
 * schema's `(space_id, user_id, name)` unique index is the authority for that —
 * so another member of the same space cannot list, rename or delete it, and a
 * bot can only be filed under a section its own user owns.
 *
 * Deleting a section does not delete its bots. `bot.section_id` is
 * `on delete set null`, so the bots survive as unfiled, which is the same
 * retention rule the bot's own deletion states in reverse.
 */

export const sectionsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/sections",
    operationId: "sectionsList",
    summary: "The actor's bot sections",
  })
  .output(z.object({ sections: z.array(botSectionSchema) }));

export const sectionsCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/sections",
    operationId: "sectionsCreate",
    summary: "Create a bot section",
  })
  .input(
    z.object({
      name: z.string().min(1).max(200),
      position: z.number().int().min(0).optional(),
    }),
  )
  .errors({
    /** The actor's user already has a section with this name. */
    CONFLICT: {
      status: 409,
      message: "A bot section with that name already exists",
    },
  })
  .output(botSectionSchema);

export const sectionsUpdateContract = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/sections/{id}",
    operationId: "sectionsUpdate",
    summary: "Rename or reorder a bot section",
  })
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      position: z.number().int().min(0).optional(),
    }),
  )
  .errors({
    /** No such section in the actor's space. */
    NOT_FOUND: {
      status: 404,
      message: "No such bot section in this space",
    },
    /** Another section of the actor's user already has this name. */
    CONFLICT: {
      status: 409,
      message: "A bot section with that name already exists",
    },
  })
  .output(botSectionSchema);

export const sectionsDeleteContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/sections/{id}",
    operationId: "sectionsDelete",
    summary: "Delete a bot section; its bots become unfiled",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot section in this space",
    },
  })
  .output(botSectionSchema);

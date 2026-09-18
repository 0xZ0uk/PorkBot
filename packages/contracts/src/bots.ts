import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The bot module: one bot, read by id.
 *
 * `bots.get` is the by-id read the gate exists for. The input is a bot id and
 * nothing else — there is no space id for a client to send, because the
 * repository bound to the actor's space is what fetches the row. A bot id from
 * another space and an id that does not exist answer the same typed `NOT_FOUND`,
 * so the response can never confirm that a guessed id exists elsewhere (PRD
 * decision 7). The output also omits `spaceId` and `userId`: the caller already
 * knows the scope it is acting in, and a response is not a place to repeat it.
 */

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
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Bot = z.infer<typeof botSchema>;

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

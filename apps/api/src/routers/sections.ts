import { authenticated } from "../gate.ts";
import { sectionOutput } from "./bots.ts";

/**
 * The sections router: the named groups bots are filed under.
 *
 * Like the bots router it holds no logic: the repositories bind the actor's
 * space, and a name conflict or a missing section arrives as a typed error the
 * gate's boundary maps to the contract's `CONFLICT` or `NOT_FOUND`. Deleting a
 * section leaves its bots in place — the schema's `set null` is the retention
 * rule — and the response says nothing about bots the caller cannot see.
 */
export function createSectionsRouter() {
  const list = authenticated.sections.list.handler(async ({ context }) => ({
    sections: (await context.repositories.sections.list()).map(sectionOutput),
  }));

  const create = authenticated.sections.create.handler(async ({ input, context }) =>
    sectionOutput(
      await context.repositories.sections.create({
        name: input.name,
        position: input.position,
      }),
    ),
  );

  const update = authenticated.sections.update.handler(async ({ input, context }) =>
    sectionOutput(
      await context.repositories.sections.update(input.id, {
        name: input.name,
        position: input.position,
      }),
    ),
  );

  const remove = authenticated.sections.delete.handler(async ({ input, context }) =>
    sectionOutput(await context.repositories.sections.delete(input.id)),
  );

  return authenticated.sections.router({ list, create, update, delete: remove });
}

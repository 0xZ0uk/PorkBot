import type { BotRecord } from "@porkbot/db";
import type { Bot } from "@porkbot/contracts";
import { authenticated } from "../gate.ts";

/**
 * The bots router: one read, by id, inside the actor's scope.
 *
 * The handler takes the bot id from input and asks the actor-scoped
 * repositories for it. The repository binds the actor's space predicate, so a
 * bot in another space and a bot that does not exist both arrive as
 * `NotFoundError`; the router does not catch it. It lets the typed error travel
 * to the gate's error boundary, which maps it to the contract's `NOT_FOUND`
 * exactly as it maps every other typed error (PRD decision 28). The
 * record-to-output mapping is transport translation and nothing more — no
 * field can widen the scope the repository was built with.
 */
export function createBotsRouter() {
  const get = authenticated.bots.get.handler(async ({ input, context }) => {
    const record = await context.repositories.bots.findById(input.id);

    return botOutput(record);
  });

  return authenticated.bots.router({ get });
}

function botOutput(record: BotRecord): Bot {
  return {
    id: record.id,
    name: record.name,
    title: record.title,
    description: record.description,
    instructions: record.instructions,
    color: record.color,
    pinned: record.pinned,
    position: record.position,
    sectionId: record.sectionId,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

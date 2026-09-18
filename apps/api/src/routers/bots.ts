import type { Bot, BotSection } from "@porkbot/contracts";
import type { BotRecord, BotSectionRecord } from "@porkbot/db";
import { authenticated } from "../gate.ts";
import type { BotService } from "../services/bots.ts";

/**
 * The bots router: the CRUD surface over the actor-scoped repositories.
 *
 * A handler takes the bot id from input and asks the repositories for it; the
 * repository binds the actor's space predicate, so a bot in another space and a
 * bot that does not exist both arrive as `NotFoundError`. The router does not
 * catch it — the typed error travels to the gate's error boundary, which maps
 * it to the contract's `NOT_FOUND` exactly as it maps every other typed error
 * (PRD decision 28). The record-to-output mapping is transport translation and
 * nothing more: no field can widen the scope the repository was built with, and
 * avatar bytes never appear in a bot body — the row carries a key, and
 * `bots.avatar` is the one read that resolves it through the storage seam.
 */

export function createBotsRouter(service: BotService) {
  const list = authenticated.bots.list.handler(async ({ input, context }) => {
    const bots = await context.repositories.bots.list(input.scope);

    return { bots: bots.map(botOutput) };
  });

  const get = authenticated.bots.get.handler(async ({ input, context }) => {
    const record = await context.repositories.bots.findById(input.id);

    return botOutput(record);
  });

  const create = authenticated.bots.create.handler(async ({ input, context }) =>
    botOutput(await context.repositories.bots.create(input)),
  );

  const update = authenticated.bots.update.handler(async ({ input, context }) =>
    botOutput(
      await context.repositories.bots.update(input.id, {
        name: input.name,
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        color: input.color,
        pinned: input.pinned,
        position: input.position,
        sectionId: input.sectionId,
        computerId: input.computerId,
      }),
    ),
  );

  const archive = authenticated.bots.archive.handler(async ({ input, context }) =>
    botOutput(await context.repositories.bots.archive(input.id)),
  );

  const restore = authenticated.bots.restore.handler(async ({ input, context }) =>
    botOutput(await context.repositories.bots.restore(input.id)),
  );

  const remove = authenticated.bots.delete.handler(async ({ input, context }) =>
    botOutput(await service.deleteBot({ repositories: context.repositories, id: input.id })),
  );

  const setAvatar = authenticated.bots.setAvatar.handler(async ({ input, context }) =>
    botOutput(
      await service.setAvatar({
        repositories: context.repositories,
        id: input.id,
        contentType: input.contentType,
        // The wire carries base64 because the RPC envelope is JSON; the seam
        // below takes bytes, so this is the only place the encoding exists.
        bytes: Buffer.from(input.data, "base64"),
      }),
    ),
  );

  const avatar = authenticated.bots.avatar.handler(async ({ input, context }) => {
    const stored = await service.readAvatar({
      repositories: context.repositories,
      id: input.id,
    });

    return { contentType: stored.contentType, data: Buffer.from(stored.bytes).toString("base64") };
  });

  const clearAvatar = authenticated.bots.clearAvatar.handler(async ({ input, context }) =>
    botOutput(await service.clearAvatar({ repositories: context.repositories, id: input.id })),
  );

  return authenticated.bots.router({
    list,
    get,
    create,
    update,
    archive,
    restore,
    delete: remove,
    setAvatar,
    avatar,
    clearAvatar,
  });
}

export function botOutput(record: BotRecord): Bot {
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
    avatarKey: record.avatarKey,
    computerId: record.computerId,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function sectionOutput(record: BotSectionRecord): BotSection {
  return {
    id: record.id,
    name: record.name,
    position: record.position,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

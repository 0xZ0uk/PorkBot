import type { BotSecretSummary } from "@porkbot/effect";
import { authenticated } from "../gate.ts";

/**
 * The bot-secret router: the operator's per-bot secrets surface over the
 * actor-scoped repositories (slice 9.6, E9 epic; reference parity BotSecret).
 *
 * The handler receives the actor-scoped repositories, so every statement is
 * bound to the session's space and a bot in another space is the same
 * `NotFoundError` a missing one gets. The response projection carries the
 * destination and a status and never a value: the store encrypts on the way in
 * and only its server-side `resolve` returns a value, which no procedure here
 * calls. The one place a value exists is the write's request body, bounded by
 * the schema and the body cap before it reaches the store.
 *
 * `put` is the operator's half of `request_secret`: the agent's ask lands as a
 * pending approval carrying the destination, and this write stores the value
 * the operator supplies. A destination that disagrees with one already stored
 * travels to the gate's boundary as the typed `BotSecretDestinationError` and
 * answers the contract's `CONFLICT`. `remove` is the forget — the same
 * immediate clear the agent's tool performs — and answers whether a value was
 * cleared so a retry is visibly a no-op.
 */
export function createBotSecretsRouter() {
  const list = authenticated.botSecrets.list.handler(async ({ input, context }) => ({
    secrets: (await context.repositories.botSecrets.list(input.botId)).map(botSecretView),
  }));

  const put = authenticated.botSecrets.put.handler(async ({ input, context }) =>
    botSecretView(
      await context.repositories.botSecrets.put(
        input.botId,
        { name: input.name, origin: input.origin, auth: input.auth },
        input.value,
      ),
    ),
  );

  const remove = authenticated.botSecrets.remove.handler(async ({ input, context }) => {
    const result = await context.repositories.botSecrets.forget(input.botId, input.name);

    return { name: input.name, removed: result.removed };
  });

  return authenticated.botSecrets.router({ list, put, remove });
}

function botSecretView(row: BotSecretSummary) {
  return {
    name: row.name,
    status: row.status,
    origin: row.origin,
    auth: row.auth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

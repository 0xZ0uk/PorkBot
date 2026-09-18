import { authenticated } from "../gate.ts";

/**
 * The account router: who the signed-in actor is. The handler reads the actor
 * the gate resolved and echoes its own scope and role; there is no input, so
 * there is no place for a caller to name a space.
 */
export function createAccountRouter() {
  const me = authenticated.account.me.handler(({ context }) => ({
    spaceId: context.actor.spaceId,
    userId: context.actor.userId,
    role: context.actor.role,
  }));

  return authenticated.account.router({ me });
}

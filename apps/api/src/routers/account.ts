import { authenticated } from "../gate.ts";
import type { DeploymentService } from "../services/deployment.ts";

/**
 * The account router: who the signed-in actor is, and who owns the deployment
 * it acts in (slice 11.5).
 *
 * `me` reads the actor the gate resolved and echoes its own scope and role;
 * `ownership` pairs that role with the deployment's configured admin address.
 * Neither input names a space, so there is no place for a caller to name one.
 * A settings table that disagrees with itself is the one outcome the contract
 * cannot express; it becomes the typed `SERVICE_UNAVAILABLE` here, with the
 * detailed value only in the request's redacted error line.
 */
export function createAccountRouter(deployment: DeploymentService) {
  const me = authenticated.account.me.handler(({ context }) => ({
    spaceId: context.actor.spaceId,
    userId: context.actor.userId,
    role: context.actor.role,
  }));

  const ownership = authenticated.account.ownership.handler(async ({ context, errors }) => {
    const result = await deployment.ownership();

    if (result.kind === "misconfigured") {
      throw errors.SERVICE_UNAVAILABLE();
    }

    return { role: context.actor.role, ownerEmail: result.ownerEmail };
  });

  return authenticated.account.router({ me, ownership });
}

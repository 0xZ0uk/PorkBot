import { authenticated } from "../gate.ts";
import type { ComputerService } from "../services/computers.ts";

/**
 * The computers router: the operator's lifecycle controls over the supervisor.
 *
 * Every handler hands the actor-scoped repositories and the bot id from input
 * to the service, which resolves the bot's assignment and dials the supervisor
 * through the injected client. The router contains no lifecycle logic and
 * names no provider: a bot without a computer, and a supervisor that refuses a
 * call, arrive as typed errors from the service and leave through the gate's
 * boundary as the contract's `NOT_FOUND` and `SERVICE_UNAVAILABLE`.
 */
export function createComputersRouter(service: ComputerService) {
  const status = authenticated.computers.status.handler(async ({ input, context }) =>
    service.status({ repositories: context.repositories, botId: input.botId }),
  );

  const boot = authenticated.computers.boot.handler(async ({ input, context }) =>
    service.boot({ repositories: context.repositories, botId: input.botId }),
  );

  const stop = authenticated.computers.stop.handler(async ({ input, context }) =>
    service.stop({ repositories: context.repositories, botId: input.botId }),
  );

  const reset = authenticated.computers.reset.handler(async ({ input, context }) =>
    service.reset({ repositories: context.repositories, botId: input.botId }),
  );

  const recover = authenticated.computers.recover.handler(async ({ input, context }) =>
    service.recover({ repositories: context.repositories, botId: input.botId }),
  );

  return authenticated.computers.router({ status, boot, stop, reset, recover });
}

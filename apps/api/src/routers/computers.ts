import { authenticated } from "../gate.ts";
import type { ComputerService } from "../services/computers.ts";

/**
 * The computers router: the operator's lifecycle controls over the supervisor,
 * the snapshot surface that makes a bad state recoverable, and the terminal
 * and file views into the machine (slice 11.4).
 *
 * Every handler hands the actor-scoped repositories and the ids from input to
 * the service, which resolves the bot's assignment and dials the supervisor
 * through the injected client. The router contains no lifecycle logic and
 * names no provider: a bot without a computer, a missing snapshot, a path that
 * leaves the home, and a supervisor that refuses a call, all arrive as typed
 * errors from the service and leave through the gate's boundary as the
 * contract's own answer.
 */
export function createComputersRouter(service: ComputerService) {
  const providers = authenticated.computers.providers.handler(async () => service.providers());

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

  const snapshot = authenticated.computers.snapshot.handler(async ({ input, context }) =>
    service.snapshot({ repositories: context.repositories, botId: input.botId }),
  );

  const snapshots = authenticated.computers.snapshots.handler(async ({ input, context }) =>
    service.snapshots({ repositories: context.repositories, botId: input.botId }),
  );

  const restore = authenticated.computers.restore.handler(async ({ input, context }) =>
    service.restore({
      repositories: context.repositories,
      botId: input.botId,
      snapshotId: input.snapshotId,
    }),
  );

  const terminal = authenticated.computers.terminal.handler(async ({ input, context }) =>
    service.terminal({
      repositories: context.repositories,
      botId: input.botId,
      command: input.command,
    }),
  );

  const files = authenticated.computers.files.handler(async ({ input, context }) =>
    service.files({
      repositories: context.repositories,
      botId: input.botId,
      path: input.path,
    }),
  );

  const file = authenticated.computers.file.handler(async ({ input, context }) =>
    service.file({
      repositories: context.repositories,
      botId: input.botId,
      path: input.path,
    }),
  );

  return authenticated.computers.router({
    providers,
    status,
    boot,
    stop,
    reset,
    recover,
    snapshot,
    snapshots,
    restore,
    terminal,
    files,
    file,
  });
}

import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerProvider,
  ComputerRef,
  ComputerStatus,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import type { ComputerView } from "@porkbot/contracts";
import type { UserRepositories } from "@porkbot/db";
import { ComputerUnavailableError, NotFoundError } from "@porkbot/effect";

/**
 * The API's half of the supervisor boundary (slice 7.1, PRD decision 20).
 *
 * The API holds no Docker socket and no provider credential: it holds a
 * `ComputerProvider` client that dials the supervisor's authenticated surface.
 * This service is the one place a contract input (a bot id) becomes the
 * computer reference at that seam, and it is deliberately thin — the operator
 * owns lifecycle decisions, not orchestration.
 *
 * The bot is read through the actor-scoped repository first, so a bot in
 * another space and a bot that does not exist are the same `NotFoundError`,
 * and the computer reference is built from the row rather than from input: a
 * caller cannot name a machine the operator never assigned. A bot with no
 * assignment answers `{ assigned: false }` for a status read and the typed
 * `NOT_FOUND` for a lifecycle operation, because there is nothing to act on.
 *
 * A provider failure is translated here, once: the supervisor's classified
 * failure becomes the transport's `ComputerUnavailableError`
 * (`SERVICE_UNAVAILABLE`), so a caller never sees a raw `ComputerProviderError`
 * and no router inspects one.
 */

/** The lifecycle verbs the supervisor client offers beyond the provider seam. */
export interface ComputerLifecycleProvider extends ComputerProvider {
  readonly reset?: (computer: ComputerRef) => Promise<ComputerStatus>;
  readonly recover?: (computer: ComputerRef) => Promise<ComputerStatus>;
}

export interface ComputerService {
  status(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerView>;
  boot(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerView>;
  stop(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerView>;
  reset(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerView>;
  recover(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerView>;
}

/**
 * The fail-closed default: a deployment that configured no supervisor refuses
 * every computer call as the typed `SERVICE_UNAVAILABLE`, classified
 * `auth_failed` because the credential pair is missing. An operator sees a
 * typed refusal instead of an opaque 500, and a test app that never touches a
 * computer needs no integration at all.
 */
export function unconfiguredComputerProvider(): ComputerLifecycleProvider {
  const refuse = () =>
    Promise.reject(
      new ComputerUnavailableError(
        "auth_failed",
        "the supervisor client is not configured on this deployment",
      ),
    );

  return {
    ensure: refuse,
    status: refuse,
    stop: refuse,
    list: refuse,
    exec: refuse,
    snapshot: refuse,
    restore: refuse,
    destroy: refuse,
  };
}

function toView(status: ComputerStatus): ComputerView {
  return status.instanceId === undefined
    ? { assigned: true, state: status.state }
    : { assigned: true, state: status.state, instanceId: status.instanceId };
}

/** The shared vocabulary the supervisor sends; anything else is a defect. */
function asProviderFailure(error: unknown): {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
} | null {
  if (!isProviderFailure(error)) {
    return null;
  }

  return { kind: error.kind, detail: error.detail ?? "the provider failed without a detail" };
}

export function createComputerService(provider: ComputerLifecycleProvider): ComputerService {
  async function reference(
    repositories: UserRepositories,
    botId: string,
  ): Promise<ComputerRef | undefined> {
    const bot = await repositories.bots.findById(botId);

    return bot.computerId === null ? undefined : { computerId: bot.computerId, botId: bot.id };
  }

  async function call(operation: () => Promise<ComputerStatus>): Promise<ComputerView> {
    try {
      return toView(await operation());
    } catch (error) {
      const failure = asProviderFailure(error);

      if (failure === null) {
        // Not a classified provider failure: a bug on this seam, which the
        // boundary answers as a defect rather than dressing up as capacity.
        throw error;
      }

      throw new ComputerUnavailableError(failure.kind, failure.detail);
    }
  }

  async function lifecycle(
    repositories: UserRepositories,
    botId: string,
    operation: (ref: ComputerRef) => Promise<ComputerStatus>,
  ): Promise<ComputerView> {
    const ref = await reference(repositories, botId);

    if (ref === undefined) {
      throw new NotFoundError("computer", botId);
    }

    return call(() => operation(ref));
  }

  function resetRef(ref: ComputerRef): Promise<ComputerStatus> {
    return provider.reset === undefined
      ? provider.destroy(ref).then(() => provider.ensure(ref))
      : provider.reset(ref);
  }

  return {
    async status({ repositories, botId }): Promise<ComputerView> {
      const ref = await reference(repositories, botId);

      if (ref === undefined) {
        return { assigned: false };
      }

      return call(() => provider.status(ref));
    },

    boot({ repositories, botId }) {
      return lifecycle(repositories, botId, (ref) => provider.ensure(ref));
    },

    stop({ repositories, botId }) {
      return lifecycle(repositories, botId, (ref) => provider.stop(ref));
    },

    reset({ repositories, botId }) {
      return lifecycle(repositories, botId, (ref) => resetRef(ref));
    },

    recover({ repositories, botId }) {
      return lifecycle(repositories, botId, (ref) =>
        provider.recover === undefined ? provider.ensure(ref) : provider.recover(ref),
      );
    },
  };
}

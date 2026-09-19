import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import type {
  ComputerProvidersView,
  ComputerProviderView,
  ComputerSnapshotView,
  ComputerView,
} from "@porkbot/contracts";
import type { ComputerSnapshotRecord, UserRepositories } from "@porkbot/db";
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
 * and no router inspects one. A `not_found` answer is the exception: it is the
 * supervisor's authoritative "the snapshot named does not exist as it was
 * captured", so a restore turns it into the contract's `NOT_FOUND` rather than
 * dressing a missing archive as an unreachable service.
 *
 * Snapshots are the operator's index of recoverable states (slice 7.5). The
 * service records a capture in the actor's space, lists a bot's captures, and
 * resolves one by its row id before asking the supervisor to restore it — so a
 * foreign snapshot id, or one belonging to another bot, is a `NOT_FOUND` before
 * the provider is dialed. The archive bytes are the supervisor's to move; the
 * API names a row, never a storage key.
 *
 * The selection surface (slice 9.4) is the same boundary read the other way:
 * `providers` reports which kinds the deployment configured and whether each
 * answers its readiness check, and `assertProviderSelectable` is the gate a
 * bot write passes before the choice is stored. A supervisor that cannot be
 * reached at all makes the read a typed `SERVICE_UNAVAILABLE` — the same fact
 * the lifecycle calls answer — while a supervisor that answers "this kind is
 * not available" makes the write the contract's `SERVICE_UNAVAILABLE` without
 * pretending the whole service is down.
 */

/** The lifecycle verbs the supervisor client offers beyond the provider seam. */
export interface ComputerLifecycleProvider extends ComputerProvider {
  readonly reset?: (computer: ComputerRef) => Promise<ComputerStatus>;
  readonly recover?: (computer: ComputerRef) => Promise<ComputerStatus>;
  /** Every kind the deployment configured and the default a bot with no selection uses. */
  readonly providers?: () => Promise<{
    readonly defaultKind: string;
    readonly kinds: readonly string[];
  }>;
  /** Asks one configured kind to prove itself; the answer is data, not an exception. */
  readonly validateProvider?: (kind: string) => Promise<{
    readonly kind: string;
    readonly available: boolean;
    readonly failure: ProviderFailureKind | null;
  }>;
}

export interface ComputerService {
  /** The deployment's configured kinds and each one's readiness (slice 9.4). */
  providers(): Promise<ComputerProvidersView>;
  /**
   * The write gate for a bot's provider selection (slice 9.4). A kind the
   * deployment has not configured, or one whose readiness check refuses, is
   * the typed `SERVICE_UNAVAILABLE`; `null`/`undefined` (no selection, or the
   * deployment default) is always allowed, because the supervisor validated
   * its default at boot.
   */
  assertProviderSelectable(kind: string | null | undefined): Promise<void>;
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
  snapshot(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ComputerSnapshotView>;
  snapshots(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<{ readonly snapshots: ComputerSnapshotView[] }>;
  restore(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
    readonly snapshotId: string;
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
    validate: refuse,
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

/** The row the operator sees; the storage key and checksum stay server-side. */
function toSnapshotView(record: ComputerSnapshotRecord): ComputerSnapshotView {
  return {
    id: record.id,
    createdAt: record.createdAt.toISOString(),
    sizeBytes: record.sizeBytes,
  };
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

    if (bot.computerId === null) {
      return undefined;
    }

    // The per-bot provider selection travels with the reference so the
    // supervisor routes the call to the provider the operator chose, while a
    // bot that selected none keeps running on the deployment's default.
    return bot.computerProvider === null
      ? { computerId: bot.computerId, botId: bot.id }
      : { computerId: bot.computerId, botId: bot.id, provider: bot.computerProvider };
  }

  /**
   * Runs a provider call and re-raises its classified failure through the
   * caller's translation; an unclassified error is a defect on this seam, so
   * it passes through rather than being dressed up as capacity.
   */
  async function answered(
    operation: () => Promise<ComputerStatus>,
    translate: (failure: { readonly kind: ProviderFailureKind; readonly detail: string }) => Error,
  ): Promise<ComputerStatus> {
    try {
      return await operation();
    } catch (error) {
      const failure = asProviderFailure(error);

      if (failure === null) {
        throw error;
      }

      throw translate(failure);
    }
  }

  const asUnavailable = (failure: {
    readonly kind: ProviderFailureKind;
    readonly detail: string;
  }): Error => new ComputerUnavailableError(failure.kind, failure.detail);

  async function call(operation: () => Promise<ComputerStatus>): Promise<ComputerView> {
    return toView(await answered(operation, asUnavailable));
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
    async providers(): Promise<ComputerProvidersView> {
      if (provider.providers === undefined || provider.validateProvider === undefined) {
        // The deployment has no supervisor configured: the catalog is
        // unknowable, which is the same unavailability the lifecycle calls
        // answer rather than an empty list a client could mistake for "none".
        throw new ComputerUnavailableError(
          "auth_failed",
          "the supervisor client is not configured on this deployment",
        );
      }

      const catalog = await provider.providers();

      // Every configured kind is checked, in the catalog's own order, and a
      // refused check is data rather than an exception: the operator sees
      // exactly which kinds exist and which of them answer.
      const checked: ComputerProviderView[] = [];

      for (const kind of catalog.kinds) {
        try {
          const validation = await provider.validateProvider(kind);

          checked.push({
            kind,
            available: validation.available,
            failure: validation.failure,
          });
        } catch (error) {
          // The check itself could not be made — a supervisor that went away
          // mid-read. That is the service being unreachable, not a provider
          // being unavailable, and it is the typed refusal for it.
          if (asProviderFailure(error) === null) {
            throw error;
          }

          throw new ComputerUnavailableError(
            "timed_out",
            `the readiness check for "${kind}" could not be made`,
          );
        }
      }

      return { defaultKind: catalog.defaultKind, providers: checked };
    },

    async assertProviderSelectable(kind): Promise<void> {
      // No selection, or the deployment default, is never a choice this gate
      // has to second-guess: the supervisor refused to boot on an unusable
      // default, so it is already validated.
      if (kind === null || kind === undefined) {
        return;
      }

      if (provider.providers === undefined || provider.validateProvider === undefined) {
        throw new ComputerUnavailableError(
          "auth_failed",
          "the supervisor client is not configured on this deployment",
        );
      }

      const catalog = await provider.providers();

      // A kind this deployment never configured is the same refusal as one it
      // configured but cannot serve: the operator's write cannot make the
      // machine exist either way, and both are answered before the row.
      if (!catalog.kinds.includes(kind)) {
        throw new ComputerUnavailableError(
          "not_found",
          `this deployment has no "${kind}" computer provider configured`,
        );
      }

      let validation;

      try {
        validation = await provider.validateProvider(kind);
      } catch (error) {
        if (asProviderFailure(error) === null) {
          throw error;
        }

        throw new ComputerUnavailableError(
          "timed_out",
          `the readiness check for "${kind}" could not be made`,
        );
      }

      if (!validation.available) {
        throw new ComputerUnavailableError(
          validation.failure ?? "not_found",
          `the "${kind}" computer provider is not available`,
        );
      }
    },

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

    async snapshot({ repositories, botId }): Promise<ComputerSnapshotView> {
      const ref = await reference(repositories, botId);

      if (ref === undefined) {
        throw new NotFoundError("computer", botId);
      }

      let handle: ComputerSnapshot;

      try {
        handle = await provider.snapshot(ref);
      } catch (error) {
        const failure = asProviderFailure(error);

        if (failure === null) {
          throw error;
        }

        throw new ComputerUnavailableError(failure.kind, failure.detail);
      }

      // The archive is in storage before the row names it. If the row cannot
      // be written — the bot was deleted mid-capture, the database refused —
      // the archive is unreachable rather than restorable, which is the safe
      // direction: nothing can restore what no row lists.
      return toSnapshotView(
        await repositories.computerSnapshots.create({
          botId,
          snapshotId: handle.snapshotId,
          storageKey: handle.key,
          sizeBytes: handle.size,
          checksum: handle.checksum,
        }),
      );
    },

    async snapshots({ repositories, botId }) {
      const records = await repositories.computerSnapshots.listForBot(botId);

      return { snapshots: records.map(toSnapshotView) };
    },

    async restore({ repositories, botId, snapshotId }): Promise<ComputerView> {
      const ref = await reference(repositories, botId);

      if (ref === undefined) {
        throw new NotFoundError("computer", botId);
      }

      const record = await repositories.computerSnapshots.findById(snapshotId);

      // A snapshot belongs to the bot it captured; one from another bot in the
      // same space is not this computer's to restore, and the provider would
      // refuse the key anyway. The scoped read is what makes that a typed
      // refusal here rather than a dial-out.
      if (record.botId !== botId) {
        throw new NotFoundError("snapshot", snapshotId);
      }

      return toView(
        await answered(
          () =>
            provider.restore(ref, {
              snapshotId: record.snapshotId,
              key: record.storageKey,
              size: record.sizeBytes,
              checksum: record.checksum,
            }),
          // The supervisor answered that the archive is missing or altered;
          // that is the snapshot refusal, not an unreachable service.
          (failure) =>
            failure.kind === "not_found"
              ? new NotFoundError("snapshot", snapshotId)
              : asUnavailable(failure),
        ),
      );
    },
  };
}

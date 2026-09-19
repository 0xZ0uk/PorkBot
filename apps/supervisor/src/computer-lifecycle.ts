import { assertComputerNetworkPlan, planComputerNetwork } from "@porkbot/core";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProxyEndpoint,
  ComputerProxyGrant,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
  CredentialProxyAdmin,
  ProviderFailure,
} from "@porkbot/adapter-kit";

/**
 * The one owner of computer lifecycle (slice 7.1, PRD decision 20; slice 7.2
 * for idle shutdown).
 *
 * Boot, stop, reset and recover are compositions of provider primitives, and
 * they live here — inside the supervisor, the only process that constructs a
 * provider — so no other process can invent a lifecycle of its own. The API
 * and the worker see only the authenticated surface in `server.ts`, which
 * delegates one-to-one; the Docker socket is never theirs.
 *
 * The four operations are defined by what survives them:
 *
 *   - boot brings the machine up or adopts the running one (`ensure`);
 *   - stop parks it, keeping its home and artifacts;
 *   - reset destroys it and boots a clean one, which is why it is the only
 *     operation that can lose state the operator did not snapshot;
 *   - recover asks the provider where the machine is and makes it running
 *     again whatever the answer — the crash path.
 *
 * Reconciliation is the boot pass that keeps a crash from orphaning machines:
 * the supervisor's in-memory knowledge dies with it, but the provider still
 * holds every container. `reconcile` lists what the provider has and adopts
 * each one — bringing a machine that should be up back up through the same
 * idempotent `ensure`, and leaving a parked one parked, because a stop the
 * operator chose is not an orphan to clean up. It reports what it adopted and
 * what it could not, so a restart leaks nothing and a single broken machine
 * does not stop the rest of the fleet from being adopted.
 *
 * Idle shutdown lives here too (slice 7.2). A computer is expensive while it
 * is running — the host floor in the README budgets about 2 GB per bot — and a
 * bot that has not run a command for `idleTimeoutMs` is parked with the same
 * `stop` an operator would use, so the home volume survives and the next run's
 * `ensure` brings the machine back with its files. Only lifecycle traffic that
 * means work counts as activity (boot, recover, reset, restore and exec);
 * asking for status does not, or an open UI tab would keep every machine
 * alive. A machine with a command in flight is never reaped, and the clock the
 * sweep reads is injected, so the policy is testable without waiting.
 *
 * Isolation is checked at the door. Every operation that can bring a machine
 * into existence computes the network plan from the computer's identity and
 * asserts it before the provider sees the reference, so a provider handed a
 * non-isolated plan is a bug in the provider, and a computer whose identity
 * cannot produce an isolated network is refused here rather than attached to
 * one that can see the host.
 */

/** What one reconciliation pass found and did. */
export interface ReconciliationReport {
  /** How many machines the provider reported it holds. */
  readonly listed: number;
  /** The machines this pass took ownership of: the running ones it kept up, the parked ones it left parked. */
  readonly adopted: readonly ComputerRef[];
  /** The machines a provider failure kept out of reach, with an operator-safe detail. */
  readonly failed: readonly { readonly computer: ComputerRef; readonly detail: string }[];
}

/** What one idle sweep considered and parked. */
export interface IdleStopReport {
  /** How many running machines were candidates (not busy with a command). */
  readonly checked: number;
  /** The machines this pass parked because their last activity was too old. */
  readonly stopped: readonly ComputerRef[];
  /** The machines a provider failure kept running, with an operator-safe detail. */
  readonly failed: readonly { readonly computer: ComputerRef; readonly detail: string }[];
}

/** The lifecycle surface the supervisor's HTTP server exposes. */
export interface ComputerLifecycle {
  boot(computer: ComputerRef): Promise<ComputerStatus>;
  stop(computer: ComputerRef): Promise<ComputerStatus>;
  reset(computer: ComputerRef): Promise<ComputerStatus>;
  recover(computer: ComputerRef): Promise<ComputerStatus>;
  status(computer: ComputerRef): Promise<ComputerStatus>;
  exec(request: ComputerExecRequest): Promise<ComputerExecResult>;
  snapshot(computer: ComputerRef): Promise<ComputerSnapshot>;
  restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus>;
  destroy(computer: ComputerRef): Promise<void>;
  list(): Promise<readonly ComputerStatus[]>;
  reconcile(): Promise<ReconciliationReport>;
  /** Parks every machine whose last real activity is older than the idle timeout. */
  stopIdle(): Promise<IdleStopReport>;
  /**
   * The credential proxy's administration (slice 7.8), present only when the
   * selected provider runs a proxy. Grants are addressed to a machine — a
   * stopped machine has no reachable proxy — and a grant is refused before the
   * provider sees it for an identity whose network plan is not isolated.
   */
  readonly proxy?: CredentialProxyAdmin;
}

export interface ComputerLifecycleOptions {
  readonly provider: ComputerProvider;
  /**
   * How long a machine may stay running without a command before the sweep
   * parks it, in milliseconds. Zero (the default) disables the sweep.
   */
  readonly idleTimeoutMs?: number | undefined;
  /** The clock the idle policy reads; injected for tests, `Date.now` by default. */
  readonly now?: (() => number) | undefined;
}

function failureDetail(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = (error as ProviderFailure).detail;

    if (typeof detail === "string" && detail.trim() !== "") {
      return detail;
    }
  }

  return error instanceof Error ? error.message : "the provider failed without a detail";
}

export function createComputerLifecycle(options: ComputerLifecycleOptions): ComputerLifecycle {
  const provider = options.provider;
  const proxyAdmin = provider.proxy;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const now = options.now ?? (() => Date.now());
  /** When each computer last did real work, by computer id. */
  const lastActivity = new Map<string, number>();
  /** Computers with a command in flight; the sweep never touches one. */
  const busy = new Set<string>();

  function assertIsolated(computer: ComputerRef): void {
    assertComputerNetworkPlan(planComputerNetwork(computer));
  }

  function touch(computer: ComputerRef): void {
    lastActivity.set(computer.computerId, now());
  }

  async function whileBusy<T>(computer: ComputerRef, run: () => Promise<T>): Promise<T> {
    busy.add(computer.computerId);

    try {
      return await run();
    } finally {
      busy.delete(computer.computerId);
    }
  }

  return {
    async boot(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      const status = await provider.ensure(computer);
      touch(computer);
      return status;
    },

    async stop(computer: ComputerRef): Promise<ComputerStatus> {
      return provider.stop(computer);
    },

    async reset(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      await provider.destroy(computer);
      const status = await provider.ensure(computer);
      touch(computer);
      return status;
    },

    async recover(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      const status = await provider.ensure(computer);
      touch(computer);
      return status;
    },

    async status(computer: ComputerRef): Promise<ComputerStatus> {
      return provider.status(computer);
    },

    async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
      touch(request.computer);
      return whileBusy(request.computer, () => provider.exec(request));
    },

    async snapshot(computer: ComputerRef): Promise<ComputerSnapshot> {
      return provider.snapshot(computer);
    },

    async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
      assertIsolated(computer);
      const status = await provider.restore(computer, snapshot);
      touch(computer);
      return status;
    },

    async destroy(computer: ComputerRef): Promise<void> {
      lastActivity.delete(computer.computerId);
      return provider.destroy(computer);
    },

    async list(): Promise<readonly ComputerStatus[]> {
      return provider.list();
    },

    async reconcile(): Promise<ReconciliationReport> {
      const listed = await provider.list();
      const adopted: ComputerRef[] = [];
      const failed: { computer: ComputerRef; detail: string }[] = [];

      for (const status of listed) {
        try {
          assertIsolated(status.computer);

          // A parked machine was parked on purpose; adoption takes ownership
          // without surprising the operator. Everything else is brought up,
          // which is idempotent for a machine that never went down.
          if (status.state !== "stopped") {
            await provider.ensure(status.computer);
          }

          // Adoption counts as activity: a machine adopted at boot is not
          // immediately idle, even though this process has never seen it work.
          touch(status.computer);
          adopted.push(status.computer);
        } catch (error) {
          failed.push({ computer: status.computer, detail: failureDetail(error) });
        }
      }

      return { listed: listed.length, adopted, failed };
    },

    async stopIdle(): Promise<IdleStopReport> {
      if (idleTimeoutMs <= 0) {
        return { checked: 0, stopped: [], failed: [] };
      }

      const listed = await provider.list();
      const stopped: ComputerRef[] = [];
      const failed: { computer: ComputerRef; detail: string }[] = [];
      let checked = 0;

      for (const status of listed) {
        if (status.state !== "running" || busy.has(status.computer.computerId)) {
          continue;
        }

        checked += 1;
        const last = lastActivity.get(status.computer.computerId) ?? now();

        if (!lastActivity.has(status.computer.computerId)) {
          // A running machine this process has never seen work: adopt it into
          // the clock rather than park it on the first sweep.
          lastActivity.set(status.computer.computerId, last);
        }

        if (now() - last < idleTimeoutMs) {
          continue;
        }

        try {
          await provider.stop(status.computer);
          lastActivity.delete(status.computer.computerId);
          stopped.push(status.computer);
        } catch (error) {
          failed.push({ computer: status.computer, detail: failureDetail(error) });
        }
      }

      return { checked, stopped, failed };
    },

    ...(proxyAdmin === undefined
      ? {}
      : {
          proxy: {
            async grant(
              computer: ComputerRef,
              grant: ComputerProxyGrant,
            ): Promise<ComputerProxyEndpoint> {
              // The same door check every lifecycle operation gets: a grant for
              // an identity that cannot produce an isolated network is refused
              // here rather than written onto a machine that can see the host.
              assertIsolated(computer);
              return await proxyAdmin.grant(computer, grant);
            },
            revoke: (computer: ComputerRef, runId: string): Promise<void> =>
              proxyAdmin.revoke(computer, runId),
            endpoint: (computer: ComputerRef): Promise<ComputerProxyEndpoint | undefined> =>
              proxyAdmin.endpoint(computer),
          } satisfies CredentialProxyAdmin,
        }),
  };
}

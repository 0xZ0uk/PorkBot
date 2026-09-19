import { assertComputerNetworkPlan, planComputerNetwork } from "@porkbot/core";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
  ProviderFailure,
} from "@porkbot/adapter-kit";

/**
 * The one owner of computer lifecycle (slice 7.1, PRD decision 20).
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
}

export interface ComputerLifecycleOptions {
  readonly provider: ComputerProvider;
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

  function assertIsolated(computer: ComputerRef): void {
    assertComputerNetworkPlan(planComputerNetwork(computer));
  }

  return {
    async boot(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      return provider.ensure(computer);
    },

    async stop(computer: ComputerRef): Promise<ComputerStatus> {
      return provider.stop(computer);
    },

    async reset(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      await provider.destroy(computer);
      return provider.ensure(computer);
    },

    async recover(computer: ComputerRef): Promise<ComputerStatus> {
      assertIsolated(computer);
      return provider.ensure(computer);
    },

    async status(computer: ComputerRef): Promise<ComputerStatus> {
      return provider.status(computer);
    },

    async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
      return provider.exec(request);
    },

    async snapshot(computer: ComputerRef): Promise<ComputerSnapshot> {
      return provider.snapshot(computer);
    },

    async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
      assertIsolated(computer);
      return provider.restore(computer, snapshot);
    },

    async destroy(computer: ComputerRef): Promise<void> {
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

          adopted.push(status.computer);
        } catch (error) {
          failed.push({ computer: status.computer, detail: failureDetail(error) });
        }
      }

      return { listed: listed.length, adopted, failed };
    },
  };
}

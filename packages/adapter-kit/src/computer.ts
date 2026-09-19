import type { FailureMapping } from "./failures.ts";

/**
 * The computer seam (PRD decision 20, stories 27–31, 34).
 *
 * A bot's computer is an isolated machine with a shell, a filesystem and a
 * browser. The supervisor — the only process holding the Docker socket — and
 * the cloud adapters implement this interface; the run executor and the tool
 * layer depend on the interface, never on Docker or a cloud SDK. Local Docker
 * (slice 7.2) and one cloud provider (slice 7.3) are the two v1.0
 * implementations, with the offline emulator (slice 6.9) as the third so the
 * whole tool path is testable with no network and no daemon.
 *
 * Everything here is provider-shaped and secret-free: a computer is addressed
 * by ids, commands cross as strings, and a credential is never a parameter.
 * Screen watch and takeover are v1.1; `frames()` and `input()` are reserved
 * here so the adapters can be retrofitted, declared optional so a v1.0 adapter
 * is not made to fake them, and implemented by the emulator so the reserved
 * path is exercised offline.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Lifecycle
 * code decides reclaim, re-provision, backoff and approval from the kind and
 * never reads a provider message.
 */

export const COMPUTER_STATES = ["running", "stopped", "gone"] as const;

/**
 * `running` answers commands, `stopped` exists but is not started, and `gone`
 * means the provider no longer holds the instance at all — the state
 * reconciliation starts from, and the one both v1.0 providers classify the
 * same way (slice 7.3).
 */
export type ComputerState = (typeof COMPUTER_STATES)[number];

/**
 * A bot's computer, addressed the same way by every provider.
 *
 * `provider` is the operator's per-bot selection (slice 7.3): the supervisor
 * resolves it against the kinds its deployment configured, and an absent value
 * means the deployment's default. A direct provider ignores it — the two live
 * providers address a machine by its ids alone — and reconciliation re-tags a
 * listed machine with the provider that holds it, so a stop never routes to
 * the wrong machine.
 */
export interface ComputerRef {
  readonly computerId: string;
  readonly botId: string;
  readonly provider?: string | undefined;
}

export interface ComputerStatus {
  readonly computer: ComputerRef;
  readonly state: ComputerState;
  /** The provider's identifier for the live instance, when one exists. */
  readonly instanceId?: string;
}

/**
 * One command inside the computer. v1.0 runs shell commands; the emulator and
 * the real providers serve file and browser tools through the same door, so
 * the tool layer never grows a second way to reach a machine.
 *
 * `timeoutMs` is a hard budget: a command that exceeds it classifies as
 * `timed_out` and is not left running in the background. Idempotency and
 * fencing are not parameters here — a durable `callId` (slice 5.5) and the
 * computer lease (slice 7.4) guard a command above this seam, which is where
 * "a retried command is a no-op" is decided.
 */
export interface ComputerExecRequest {
  readonly computer: ComputerRef;
  readonly command: string;
  readonly timeoutMs: number;
}

export interface ComputerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A captured snapshot. The archive itself lives through the storage seam
 * (slice 7.7); the computer seam only names it, so a snapshot survives the
 * computer it came from and can be restored into a rebuilt one.
 */
export interface ComputerSnapshot {
  readonly snapshotId: string;
  readonly key: string;
}

/** One frame of the reserved screen path (v1.1); `data` is encoded per `mediaType`. */
export interface ComputerFrame {
  readonly capturedAt: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/**
 * One input event on the reserved screen path (v1.1). Pointer coordinates are
 * in the frame's pixel space, so an adapter never has to guess a scale.
 */
export type ComputerInput =
  | {
      readonly type: "pointer";
      readonly x: number;
      readonly y: number;
      readonly action: "move" | "click";
    }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "text"; readonly text: string };

export interface ComputerProvider {
  /**
   * Bring the computer up, or adopt the one already running. Idempotent: a
   * second call for the same reference does not create a second machine, which
   * is what makes recover-on-boot safe.
   */
  ensure(computer: ComputerRef): Promise<ComputerStatus>;
  /** Current state; `gone` is an answer, not an error, so reconciliation can act on it. */
  status(computer: ComputerRef): Promise<ComputerStatus>;
  /**
   * Park the computer without destroying it (slice 7.1): the machine stops
   * answering, its home and its artifacts survive, and `ensure` starts it
   * again. Idempotent, like `ensure` — stopping a stopped or never-seen
   * computer is a status report, not an error — so the supervisor's stop path
   * is safe to retry after a crash.
   */
  stop(computer: ComputerRef): Promise<ComputerStatus>;
  /**
   * Every computer the provider currently holds, running or stopped (slice
   * 7.1). Reconciliation reads this after a supervisor crash to adopt what is
   * still alive instead of leaking it, so a provider that cannot enumerate its
   * own instances cannot be recovered from. A machine the provider has already
   * destroyed is absent, never a `gone` entry.
   */
  list(): Promise<readonly ComputerStatus[]>;
  /** Run one command; a command against a `gone` computer fails with `gone`. */
  exec(request: ComputerExecRequest): Promise<ComputerExecResult>;
  /** Capture the agent home and declared state; processes and external sessions are not captured. */
  snapshot(computer: ComputerRef): Promise<ComputerSnapshot>;
  /** Restore a snapshot into a computer, creating it if needed. */
  restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus>;
  /** Idempotent: destroying a computer that is already gone succeeds. */
  destroy(computer: ComputerRef): Promise<void>;
  /** Reserved for v1.1 screen watch. */
  frames?(computer: ComputerRef): AsyncIterable<ComputerFrame>;
  /** Reserved for v1.1 screen takeover. */
  input?(computer: ComputerRef, input: ComputerInput): Promise<void>;
}

export const failureMapping: FailureMapping = {
  gone: "The instance no longer exists at the provider (a removed container, an expired or deleted cloud instance); every operation on that handle raises it until re-provisioning.",
  not_found:
    "A path, snapshot or process named inside a running computer does not exist, while the computer itself is fine.",
  rate_limited:
    "The provider's control plane refuses a lifecycle call under a quota (HTTP 429); the caller backs off instead of failing the run.",
  timed_out:
    "Boot, command or lifecycle call exceeded the caller's budget; the machine's state is then unknown and must be re-read before reuse.",
  auth_failed:
    "The control-plane credential is missing or refused (401/403); fail closed and never retry the same key.",
};

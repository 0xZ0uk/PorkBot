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
 *
 * `environment` is per-command environment, applied to the exec'd process
 * alone: it is never written into the computer's own container spec, so it
 * cannot become a credential that outlives the call (slice 7.8). The fenced
 * command runner is the only writer — the tool layer never sets it — and what
 * it carries is a capability, never a stored credential: the proxy URL the
 * command may call and the short-lived run token the proxy verifies.
 */
export interface ComputerExecRequest {
  readonly computer: ComputerRef;
  readonly command: string;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface ComputerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A captured snapshot: the archive's address plus the two facts that prove the
 * bytes are the ones that were captured.
 *
 * The archive itself lives through the storage seam (slice 7.7); the computer
 * seam only names it, so a snapshot survives the computer it came from and can
 * be restored into a rebuilt one. `size` is the archive's byte length and
 * `checksum` is the lowercase hex SHA-256 of those bytes; a restore verifies
 * both before it touches the machine, so a truncated or altered archive is a
 * typed `not_found` instead of a half-booted computer.
 *
 * A snapshot captures the agent home — the files the agent wrote and keeps —
 * and nothing else. Running processes, open sessions, network connections and
 * anything held outside the home are not captured; a restore brings the files
 * back into a fresh machine, not the processes that were writing them.
 */
export interface ComputerSnapshot {
  readonly snapshotId: string;
  /** The storage-seam key the archive lives under, scoped to one computer. */
  readonly key: string;
  /** The archive's byte length, as captured. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the archive's bytes, as captured. */
  readonly checksum: string;
}

/** The one checksum shape a snapshot carries: lowercase hex SHA-256. */
export const snapshotChecksumPattern = /^[0-9a-f]{64}$/;

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

/**
 * One upstream a run may reach through its computer's credential proxy (slice
 * 7.8, PRD decision 29; audit P1 item 7).
 *
 * The sandbox addresses the upstream by `name` alone — it never learns the
 * origin, and the `headers` the proxy injects are the credential material the
 * run resolved server-side. A name with no `headers` is a plain allowlist
 * entry: reachable, but carrying nothing the run did not already know.
 */
export interface ProxyUpstreamGrant {
  /** The name the sandbox calls, for example `model` or `github`. */
  readonly name: string;
  /** The absolute origin the proxy forwards to: `https://host[:port]`, no path. */
  readonly origin: string;
  /** Headers the proxy adds to every forwarded request for this upstream. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The whole of one run's credentialed egress, in one grant (slice 7.8).
 *
 * The grant is written to the computer's proxy when the run starts and removed
 * when it ends; `expiresAtSeconds` is the bound a crashed writer cannot
 * escape, because the proxy refuses the grant once the wall clock passes it.
 * The proxy holds the material; the sandbox holds only the capability token
 * that names this grant's run.
 */
export interface ComputerProxyGrant {
  readonly runId: string;
  /** The grant's hard deadline, in whole Unix seconds. */
  readonly expiresAtSeconds: number;
  /** Every upstream this run may reach; anything unnamed is refused. */
  readonly upstreams: readonly ProxyUpstreamGrant[];
}

/** Where a computer's proxy is reached from inside the sandbox. */
export interface ComputerProxyEndpoint {
  /** The base URL a command calls, for example `http://porkbot-proxy-abc123:8321`. */
  readonly url: string;
}

/**
 * The credential-proxy administration seam (slice 7.8, PRD decision 29).
 *
 * A computer's proxy is the only door credentialed egress takes out of a
 * sandbox: the run's grants live in it, the sandbox holds a scoped capability
 * rather than a key, and a grant dies with the run that wrote it. Providers
 * implement it differently — Docker runs a per-computer sidecar on the
 * isolated network, the emulator runs the same proxy on loopback — but the
 * semantics are shared: `grant` publishes or replaces one run's upstream set,
 * `revoke` removes it, and `endpoint` names the address the run's commands
 * are given, when the provider runs a proxy at all.
 *
 * A provider without one leaves `proxy` unset, which is the honest answer for
 * a provider that cannot isolate a proxy inside its sandbox boundary — the
 * caller learns there is no proxy instead of pretending credentials crossed
 * a boundary they did not.
 */
export interface CredentialProxyAdmin {
  /**
   * Publish one run's grant on the computer's proxy, replacing any grant the
   * run already held. Returns the endpoint the sandbox addresses; the caller
   * hands it to the command's environment together with the run's capability.
   */
  grant(computer: ComputerRef, grant: ComputerProxyGrant): Promise<ComputerProxyEndpoint>;
  /**
   * Remove the run's grant. Idempotent, because the settle path calls it on
   * every terminal run whether or not a grant was ever written.
   */
  revoke(computer: ComputerRef, runId: string): Promise<void>;
  /** The proxy's endpoint for this computer, or `undefined` when it has none. */
  endpoint(computer: ComputerRef): Promise<ComputerProxyEndpoint | undefined>;
}

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
  /**
   * Restore a snapshot into a computer, creating it if needed. The archive is
   * fetched and verified against the snapshot's `size` and `checksum` before
   * the existing machine is replaced, so a missing or altered archive is the
   * typed `not_found` and the computer is left as it was.
   */
  restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus>;
  /** Idempotent: destroying a computer that is already gone succeeds. */
  destroy(computer: ComputerRef): Promise<void>;
  /** Reserved for v1.1 screen watch. */
  frames?(computer: ComputerRef): AsyncIterable<ComputerFrame>;
  /** Reserved for v1.1 screen takeover. */
  input?(computer: ComputerRef, input: ComputerInput): Promise<void>;
  /**
   * The computer's credential proxy administration (slice 7.8), present only
   * on providers that can run one inside the sandbox's isolation boundary.
   */
  readonly proxy?: CredentialProxyAdmin;
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

/**
 * Bounded exponential backoff with jitter.
 *
 * PRD decision 18: a reconnecting client uses one backoff implementation,
 * owned here and consumed by every surface, so web, desktop and mobile cannot
 * drift into three reconnect curves. The policy is data and the delay is a
 * pure function of the attempt number, the policy and a random source — no
 * timers, no state — so each surface still owns its own reconnect loop while
 * the arithmetic stays in one place.
 *
 * The bound comes first and jitter comes second: the exponential is capped at
 * `maxDelayMs`, then a fraction of that (up to the whole of it) is shaved off.
 * A delay can therefore never exceed `maxDelayMs`, whatever the attempt number
 * or the random source does.
 */

export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds. */
  readonly baseDelayMs: number;
  /** Hard ceiling: no delay ever exceeds this. */
  readonly maxDelayMs: number;
  /** Growth factor per attempt; 1 is a constant delay. */
  readonly multiplier: number;
  /**
   * Fraction of the bounded delay the jitter may remove, from 0 (no jitter,
   * deterministic) to 1 (full jitter, anywhere from zero to the ceiling).
   */
  readonly jitterRatio: number;
}

/**
 * The one reconnect policy shared by every surface: one second growing
 * exponentially to a thirty-second ceiling, half of each delay jittered away
 * so a fleet of reconnecting clients does not stampede in lockstep.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.5,
};

export interface BackoffOptions {
  readonly policy?: BackoffPolicy | undefined;
  /** Injectable randomness, so a caller and its tests can be deterministic. */
  readonly random?: (() => number) | undefined;
}

function assertPositiveFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number, received ${String(value)}`);
  }
}

function assertPolicy(policy: BackoffPolicy): void {
  assertPositiveFinite(policy.baseDelayMs, "baseDelayMs");
  assertPositiveFinite(policy.maxDelayMs, "maxDelayMs");

  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError(
      `maxDelayMs must not be smaller than baseDelayMs, received ${String(policy.maxDelayMs)} < ${String(policy.baseDelayMs)}`,
    );
  }

  if (
    typeof policy.multiplier !== "number" ||
    !Number.isFinite(policy.multiplier) ||
    policy.multiplier < 1
  ) {
    throw new RangeError(
      `multiplier must be a finite number of at least 1, received ${String(policy.multiplier)}`,
    );
  }

  if (
    typeof policy.jitterRatio !== "number" ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new RangeError(
      `jitterRatio must be a finite number in [0, 1], received ${String(policy.jitterRatio)}`,
    );
  }
}

/**
 * The delay before retry number `attempt` (1-based), in whole milliseconds.
 * Never above `policy.maxDelayMs`; below the ceiling only by the policy's own
 * jitter. A retry loop awaits this before each attempt — it is the only
 * backoff arithmetic in the workspace.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive safe integer, received ${String(attempt)}`);
  }

  const policy = options.policy ?? DEFAULT_BACKOFF;
  assertPolicy(policy);

  const random = options.random ?? Math.random;
  const unit = random();
  if (typeof unit !== "number" || !Number.isFinite(unit) || unit < 0 || unit > 1) {
    throw new RangeError(`random must return a finite number in [0, 1], received ${String(unit)}`);
  }

  const ceiling = Math.min(
    policy.baseDelayMs * policy.multiplier ** (attempt - 1),
    policy.maxDelayMs,
  );
  const jittered = ceiling * (1 - policy.jitterRatio + policy.jitterRatio * unit);

  return Math.round(jittered);
}

import { describe, expect, it } from "vitest";
import { backoffDelayMs, DEFAULT_BACKOFF } from "./backoff.ts";
import type { BackoffPolicy } from "./backoff.ts";

const fixed = (value: number) => () => value;

const noJitter: BackoffPolicy = {
  baseDelayMs: 100,
  maxDelayMs: 800,
  multiplier: 2,
  jitterRatio: 0,
};

describe("backoffDelayMs", () => {
  it("grows exponentially until the ceiling, then stays there", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      backoffDelayMs(attempt, { policy: noJitter, random: fixed(1) }),
    );

    expect(delays).toEqual([100, 200, 400, 800, 800, 800, 800]);
  });

  it("never exceeds the ceiling, for any attempt or random value", () => {
    for (const attempt of [1, 2, 5, 10, 100, Number.MAX_SAFE_INTEGER]) {
      for (const unit of [0, 0.01, 0.5, 0.99, 1]) {
        for (const policy of [
          noJitter,
          DEFAULT_BACKOFF,
          { ...noJitter, jitterRatio: 1 },
          { ...noJitter, baseDelayMs: 250, maxDelayMs: 250 },
          { ...noJitter, multiplier: 10 },
        ]) {
          const delay = backoffDelayMs(attempt, { policy, random: fixed(unit) });

          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
          expect(Number.isInteger(delay)).toBe(true);
        }
      }
    }
  });

  it("keeps a jittered delay within the policy's band", () => {
    const policy: BackoffPolicy = { ...noJitter, jitterRatio: 0.4 };
    const ceiling = 400;

    for (const unit of [0, 0.1, 0.5, 0.9, 1]) {
      const delay = backoffDelayMs(3, { policy, random: fixed(unit) });

      expect(delay).toBeGreaterThanOrEqual(ceiling * (1 - policy.jitterRatio));
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("is deterministic with no jitter and jittered otherwise", () => {
    const deterministic = [0, 0.5, 1].map((unit) =>
      backoffDelayMs(2, { policy: noJitter, random: fixed(unit) }),
    );
    expect(deterministic).toEqual([200, 200, 200]);

    const jittered = [0, 0.5, 1].map((unit) =>
      backoffDelayMs(2, { policy: DEFAULT_BACKOFF, random: fixed(unit) }),
    );
    expect(jittered).toEqual([1_000, 1_500, 2_000]);
  });

  it("spreads full jitter across the whole band", () => {
    const policy: BackoffPolicy = { ...noJitter, jitterRatio: 1 };

    expect(backoffDelayMs(1, { policy, random: fixed(0) })).toBe(0);
    expect(backoffDelayMs(1, { policy, random: fixed(0.25) })).toBe(25);
    expect(backoffDelayMs(1, { policy, random: fixed(1) })).toBe(100);
  });

  it("treats a multiplier of 1 as a constant delay", () => {
    const policy: BackoffPolicy = { ...noJitter, multiplier: 1 };

    expect(backoffDelayMs(1, { policy, random: fixed(1) })).toBe(100);
    expect(backoffDelayMs(20, { policy, random: fixed(1) })).toBe(100);
  });

  it("rounds to whole milliseconds", () => {
    const policy: BackoffPolicy = {
      baseDelayMs: 100.4,
      maxDelayMs: 900,
      multiplier: 2,
      jitterRatio: 0,
    };
    expect(backoffDelayMs(1, { policy, random: fixed(1) })).toBe(100);

    const rounding: BackoffPolicy = { ...policy, baseDelayMs: 100.5 };
    expect(backoffDelayMs(1, { policy: rounding, random: fixed(1) })).toBe(101);
  });

  it("applies the default policy when none is given", () => {
    expect(DEFAULT_BACKOFF.baseDelayMs).toBe(1_000);
    expect(DEFAULT_BACKOFF.maxDelayMs).toBe(30_000);
    expect(DEFAULT_BACKOFF.multiplier).toBe(2);
    expect(DEFAULT_BACKOFF.jitterRatio).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.jitterRatio).toBeLessThan(1);

    for (const attempt of [1, 2, 3, 10, 100]) {
      const delay = backoffDelayMs(attempt);
      const ceiling = Math.min(
        DEFAULT_BACKOFF.baseDelayMs * DEFAULT_BACKOFF.multiplier ** (attempt - 1),
        DEFAULT_BACKOFF.maxDelayMs,
      );

      expect(delay).toBeGreaterThanOrEqual(Math.round(ceiling * (1 - DEFAULT_BACKOFF.jitterRatio)));
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("accepts an explicitly undefined policy or random source", () => {
    expect(() => backoffDelayMs(1, { policy: undefined, random: undefined })).not.toThrow();
  });

  it("rejects an attempt that is not a positive safe integer", () => {
    for (const attempt of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => backoffDelayMs(attempt)).toThrow(RangeError);
      expect(() => backoffDelayMs(attempt)).toThrow(/attempt/);
    }

    expect(() => backoffDelayMs("1" as unknown as number)).toThrow(RangeError);
  });

  it("rejects an invalid policy before it computes a delay", () => {
    const invalidPolicies: readonly BackoffPolicy[] = [
      { ...noJitter, baseDelayMs: 0 },
      { ...noJitter, baseDelayMs: -1 },
      { ...noJitter, baseDelayMs: NaN },
      { ...noJitter, baseDelayMs: Infinity },
      { ...noJitter, maxDelayMs: 0 },
      { ...noJitter, maxDelayMs: 50 },
      { ...noJitter, maxDelayMs: NaN },
      { ...noJitter, multiplier: 0.5 },
      { ...noJitter, multiplier: NaN },
      { ...noJitter, multiplier: Infinity },
      { ...noJitter, jitterRatio: -0.01 },
      { ...noJitter, jitterRatio: 1.01 },
      { ...noJitter, jitterRatio: NaN },
    ];

    for (const policy of invalidPolicies) {
      expect(() => backoffDelayMs(1, { policy })).toThrow(RangeError);
    }
  });

  it("rejects a random source that leaves the unit interval", () => {
    for (const unit of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => backoffDelayMs(1, { random: fixed(unit) })).toThrow(RangeError);
      expect(() => backoffDelayMs(1, { random: fixed(unit) })).toThrow(/random/);
    }

    expect(() => backoffDelayMs(1, { random: fixed("0.5" as unknown as number) })).toThrow(
      RangeError,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  decideRoutineDue,
  InvalidRoutineCron,
  InvalidRoutineTimezone,
  isRoutineTimezone,
  nextRoutineFire,
  parseRoutineCron,
  ROUTINE_MISS_GRACE_MS,
  RoutineScheduleError,
  UnreachableRoutineSchedule,
} from "./routine-schedule.ts";

/**
 * The schedule's answers, at exact instants.
 *
 * Every DST assertion names a date whose transition is a matter of record, so
 * the policies the module documents — nonexistent times fire at the gap,
 * ambiguous times fire once — are checked against known transitions instead of
 * against the host's timezone or the day the suite runs.
 */

function fire(expression: string, timezone: string, after: string): string {
  return nextRoutineFire(parseRoutineCron(expression), timezone, new Date(after)).toISOString();
}

describe("parsing a routine cron expression", () => {
  it("reads a wildcard expression as every value in every field", () => {
    const cron = parseRoutineCron("* * * * *");

    expect(cron.minutes).toHaveLength(60);
    expect(cron.hours).toHaveLength(24);
    expect(cron.daysOfMonth).toHaveLength(31);
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cron.dayOfMonthUnrestricted).toBe(true);
    expect(cron.dayOfWeekUnrestricted).toBe(true);
  });

  it("reads single values, lists, ranges and steps", () => {
    const cron = parseRoutineCron("0,15,45 9-17/4 1-15/7 JAN,MAR MON-FRI");

    expect(cron.minutes).toEqual([0, 15, 45]);
    expect(cron.hours).toEqual([9, 13, 17]);
    expect(cron.daysOfMonth).toEqual([1, 8, 15]);
    expect(cron.months).toEqual([1, 3]);
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats a field that covers its whole range as unrestricted, including 0-7", () => {
    const cron = parseRoutineCron("0 0 1-31 * 0-7");

    expect(cron.dayOfMonthUnrestricted).toBe(true);
    expect(cron.dayOfWeekUnrestricted).toBe(true);
    expect(cron.daysOfWeek).toHaveLength(7);
  });

  it("normalizes Sunday written as 7 to 0", () => {
    expect(parseRoutineCron("0 0 * * 7").daysOfWeek).toEqual([0]);
    expect(parseRoutineCron("0 0 * * 0,7").daysOfWeek).toEqual([0]);
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(parseRoutineCron("  30   2  *  *  *  ").expression).toBe("  30   2  *  *  *  ");
    expect(parseRoutineCron("  30   2  *  *  *  ").minutes).toEqual([30]);
  });

  it.each([
    ["* * * *", "four fields"],
    ["* * * * * *", "six fields"],
    ["60 * * * *", "minute outside 0-59"],
    ["* 24 * * *", "hour outside 0-23"],
    ["0 0 0 * *", "day of month outside 1-31"],
    ["0 0 32 * *", "day of month outside 1-31"],
    ["0 0 * 13 *", "month outside 1-12"],
    ["0 0 * * 8", "day of week outside 0-7"],
    ["30-10 * * * *", "range that runs backwards"],
    ["*/0 * * * *", "zero step"],
    ["*/x * * * *", "non-numeric step"],
    ["7/10 * * * *", "step without a range"],
    ["1,,2 * * * *", "empty list element"],
    ["? * * * *", "Quartz question mark"],
    ["0 0 L * *", "Quartz L"],
    ["0 0 * * 5#2", "Quartz nth-weekday"],
    ["0 0 * FOO *", "unknown name"],
    ["0 0 * *", "missing fields"],
  ])("refuses %s (%s)", (expression, reason) => {
    expect(() => parseRoutineCron(expression), reason).toThrow(InvalidRoutineCron);
  });

  it("names the field and the expression in a refusal", () => {
    expect(() => parseRoutineCron("0 24 * * *")).toThrow(
      'The routine cron expression "0 24 * * *" is invalid: the hour value "24" is outside 0-23',
    );
  });
});

describe("validating a routine timezone", () => {
  it("accepts the runtime's IANA zones", () => {
    expect(isRoutineTimezone("UTC")).toBe(true);
    expect(isRoutineTimezone("America/New_York")).toBe(true);
    expect(isRoutineTimezone("Europe/London")).toBe(true);
  });

  it("refuses a zone the runtime does not know", () => {
    expect(isRoutineTimezone("Mars/Olympus_Mons")).toBe(false);
    expect(isRoutineTimezone("")).toBe(false);
    expect(() => nextRoutineFire(parseRoutineCron("* * * * *"), "Nope/Nope", new Date(0))).toThrow(
      InvalidRoutineTimezone,
    );
  });

  it("refuses an invalid date to search from", () => {
    expect(() =>
      nextRoutineFire(parseRoutineCron("* * * * *"), "UTC", new Date(Number.NaN)),
    ).toThrow(RoutineScheduleError);
  });
});

describe("the next routine fire", () => {
  it("is strictly after the instant asked from", () => {
    expect(fire("0 * * * *", "UTC", "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T01:00:00.000Z");
    expect(fire("0 * * * *", "UTC", "2026-01-01T01:00:00.000Z")).toBe("2026-01-01T02:00:00.000Z");
    expect(fire("0 * * * *", "UTC", "2026-01-01T01:00:30.000Z")).toBe("2026-01-01T02:00:00.000Z");
  });

  it("steps by minutes within an hour", () => {
    expect(fire("*/15 * * * *", "UTC", "2026-01-01T00:07:00.000Z")).toBe(
      "2026-01-01T00:15:00.000Z",
    );
    expect(fire("0,15,45 * * * *", "UTC", "2026-01-01T00:15:00.000Z")).toBe(
      "2026-01-01T00:45:00.000Z",
    );
  });

  it("rolls over days, months and years", () => {
    expect(fire("0 0 15 * *", "UTC", "2026-01-20T00:00:00.000Z")).toBe("2026-02-15T00:00:00.000Z");
    expect(fire("59 23 31 12 *", "UTC", "2026-01-01T00:00:00.000Z")).toBe(
      "2026-12-31T23:59:00.000Z",
    );
    expect(fire("0 0 1 JAN *", "UTC", "2026-12-01T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("finds a leap day, which no other February has", () => {
    expect(fire("0 0 29 2 *", "UTC", "2025-03-01T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses an expression that can never fire instead of searching forever", () => {
    expect(() => fire("0 0 31 2 *", "UTC", "2026-01-01T00:00:00.000Z")).toThrow(
      UnreachableRoutineSchedule,
    );
  });

  it("follows the day-of-week field when the day of month is unrestricted", () => {
    // 2026-04-01 is a Wednesday; the next Monday is the 6th.
    expect(fire("0 0 * * 1", "UTC", "2026-04-01T00:00:00.000Z")).toBe("2026-04-06T00:00:00.000Z");
    expect(fire("0 9 * * MON-FRI", "UTC", "2026-04-04T00:00:00.000Z")).toBe(
      "2026-04-06T09:00:00.000Z",
    );
  });

  it("follows the day-of-month field when the day of week is unrestricted", () => {
    expect(fire("0 0 13 * *", "UTC", "2026-04-01T00:00:00.000Z")).toBe("2026-04-13T00:00:00.000Z");
  });

  it("matches either day field when both constrain, as cron does", () => {
    // 2026-04-13 is a Monday, but it is the 13th, so the OR rule fires it even
    // though the day of week is a Friday rule; the Fridays before it fire too.
    expect(fire("0 0 13 * 5", "UTC", "2026-04-01T00:00:00.000Z")).toBe("2026-04-03T00:00:00.000Z");
    expect(fire("0 0 13 * 5", "UTC", "2026-04-03T00:00:00.000Z")).toBe("2026-04-10T00:00:00.000Z");
    expect(fire("0 0 13 * 5", "UTC", "2026-04-10T00:00:00.000Z")).toBe("2026-04-13T00:00:00.000Z");
  });

  it("resolves the wall clock in the routine's timezone, not UTC", () => {
    expect(fire("30 9 * * *", "America/New_York", "2026-06-01T00:00:00.000Z")).toBe(
      "2026-06-01T13:30:00.000Z",
    );
    expect(fire("30 9 * * *", "America/New_York", "2026-01-15T00:00:00.000Z")).toBe(
      "2026-01-15T14:30:00.000Z",
    );
  });

  it("fires a nonexistent spring-forward time once, when the clock passes it", () => {
    // 2026-03-08 02:00 America/New_York jumps to 03:00, so 02:30 is a wall
    // clock time that never appears; the run happens at the transition.
    expect(fire("30 2 * * *", "America/New_York", "2026-03-08T00:00:00.000Z")).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // The day before has an ordinary 02:30, and the day after is back on the
    // new offset: no skipped day and no double fire.
    expect(fire("30 2 * * *", "America/New_York", "2026-03-07T00:00:00.000Z")).toBe(
      "2026-03-07T07:30:00.000Z",
    );
    expect(fire("30 2 * * *", "America/New_York", "2026-03-08T07:00:00.000Z")).toBe(
      "2026-03-09T06:30:00.000Z",
    );
    // Europe/London's gap is 01:00 to 02:00 on 2026-03-29: the same policy,
    // a different transition hour.
    expect(fire("30 1 * * *", "Europe/London", "2026-03-29T00:00:00.000Z")).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });

  it("fires an ambiguous fall-back time once, on its first occurrence", () => {
    // 2026-11-01 America/New_York has two 01:30s: 05:30Z (EDT) and 06:30Z
    // (EST). The first is the fire; asking from inside the repeated hour does
    // not replay the second.
    expect(fire("30 1 * * *", "America/New_York", "2026-11-01T00:00:00.000Z")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(fire("30 1 * * *", "America/New_York", "2026-11-01T05:30:00.000Z")).toBe(
      "2026-11-02T06:30:00.000Z",
    );
    expect(fire("30 1 * * *", "America/New_York", "2026-11-01T06:00:00.000Z")).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("keeps midnight on a spring-forward day at local midnight", () => {
    expect(fire("0 0 * * *", "America/New_York", "2026-03-08T06:00:00.000Z")).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });
});

describe("the due decision", () => {
  const cron = parseRoutineCron("* * * * *");
  const slot = new Date("2026-01-01T00:00:00.000Z");

  it("waits when the slot is still ahead", () => {
    const decision = decideRoutineDue({
      cron,
      timezone: "UTC",
      nextRunAt: slot,
      now: new Date("2025-12-31T23:59:59.999Z"),
    });

    expect(decision).toEqual({ action: "wait", nextRunAt: slot });
  });

  it("fires the slot on time and advances to its immediate successor", () => {
    expect(decideRoutineDue({ cron, timezone: "UTC", nextRunAt: slot, now: slot })).toEqual({
      action: "fire",
      scheduledFor: slot,
      nextRunAt: new Date("2026-01-01T00:01:00.000Z"),
      lateByMs: 0,
    });
  });

  it("still fires a slot exactly at the grace boundary", () => {
    const decision = decideRoutineDue({
      cron,
      timezone: "UTC",
      nextRunAt: slot,
      now: new Date(slot.getTime() + ROUTINE_MISS_GRACE_MS),
    });

    expect(decision.action).toBe("fire");
  });

  it("records a slot past the grace as missed and jumps to the next future fire", () => {
    const now = new Date(slot.getTime() + ROUTINE_MISS_GRACE_MS + 1);
    const decision = decideRoutineDue({ cron, timezone: "UTC", nextRunAt: slot, now });

    expect(decision).toEqual({
      action: "miss",
      scheduledFor: slot,
      nextRunAt: new Date("2026-01-01T00:06:00.000Z"),
      lateByMs: ROUTINE_MISS_GRACE_MS + 1,
    });
  });

  it("catches up one slot per decision when the schedule runs faster than the ticks", () => {
    // A minute schedule that was down for three minutes is within the grace,
    // so it fires each pending slot in turn rather than skipping wall times.
    const second = new Date("2026-01-01T00:01:00.000Z");
    const third = new Date("2026-01-01T00:02:00.000Z");
    const first = decideRoutineDue({ cron, timezone: "UTC", nextRunAt: slot, now: third });

    expect(first.action).toBe("fire");
    expect(first.action === "fire" ? first.nextRunAt : undefined).toEqual(second);

    const secondDecision = decideRoutineDue({
      cron,
      timezone: "UTC",
      nextRunAt: second,
      now: third,
    });

    expect(secondDecision.action).toBe("fire");
    expect(secondDecision.action === "fire" ? secondDecision.nextRunAt : undefined).toEqual(third);
  });
});

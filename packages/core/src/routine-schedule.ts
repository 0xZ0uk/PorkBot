/**
 * Routine schedules: the one place a cron expression and a timezone become an
 * instant (PRD decision 22, slice 8.4).
 *
 * A routine is a row, and two of its columns are the schedule: a five-field
 * cron expression and an IANA timezone name. This module owns what those mean.
 * It is pure — no clock, no database, no I/O — so the scheduler passes `now`
 * in and the DST answers below are testable at an exact instant rather than by
 * waiting for a transition.
 *
 * Four decisions are deliberate and stated here because a scheduler that is
 * vague about them runs at the wrong time once a year:
 *
 *   - **The wall clock is the schedule's clock.** `30 2 * * *` in
 *     `America/New_York` means 02:30 local, not 02:30 UTC shifted by whatever
 *     offset was in effect when the routine was created. `nextRoutineFire`
 *     resolves each candidate local time to an instant on every call.
 *   - **A nonexistent local time fires once, at the moment the clock passes
 *     it.** On the spring-forward day 02:30 does not exist; the routine fires
 *     at the transition instant (03:00 local), not twice and not never.
 *   - **An ambiguous local time fires once, on its first occurrence.** When
 *     01:30 happens twice on the fall-back day, the routine fires at the
 *     earlier instant; the second 01:30 is the same wall-clock time and is not
 *     a second schedule.
 *   - **The day-of-month and day-of-week fields combine with OR** when both
 *     constrain the day, as cron has always done. A field covering its whole
 *     range (which includes `*` and `1-31`) imposes no constraint.
 *
 * A fire time is a local wall-clock minute strictly after the instant the
 * caller asks from, so a routine never fires twice for one schedule. The
 * parser accepts a wildcard, single values, `a-b` ranges, a step over a range
 * or a wildcard, and comma lists, plus `JAN`-`DEC` and `SUN`-`SAT` names; it
 * rejects Quartz extensions (`?`, `L`, `W`, `#`) by name rather than guessing
 * at them.
 *
 * The scheduler's second half is `decideRoutineDue`: given the slot the
 * routine is waiting on and the database's clock, it either fires that slot or
 * records it missed. The grace is fixed here so every caller shares one answer:
 * a slot up to `ROUTINE_MISS_GRACE_MS` late still runs (a tick delayed by load
 * is not a missed schedule), and a slot older than that is recorded missed and
 * the schedule jumps to the next future fire — a downtime is visible, and it
 * is never replayed as a burst of stale runs.
 */

/** How long a due slot may be late and still run, before it is recorded missed. */
export const ROUTINE_MISS_GRACE_MS = 5 * 60 * 1000;

/** The fields of the accepted expression, in order, for error messages. */
export const ROUTINE_CRON_FIELDS = [
  "minute",
  "hour",
  "day of month",
  "month",
  "day of week",
] as const;

/**
 * How far ahead a valid expression is searched for its next fire: eight years,
 * so a February 29 schedule always finds a leap year before giving up.
 */
const MAX_FIRE_HORIZON_DAYS = 366 * 8;

/**
 * The longest a timezone transition may move the wall clock while resolving one
 * local time. Two days covers the historical date-line skips (Apia, 2011)
 * without an unbounded loop.
 */
const MAX_WALL_CLOCK_SHIFT_MINUTES = 2 * 24 * 60;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** A parsed routine schedule: the expression and the sets it stands for. */
export interface RoutineCron {
  /** The original text, exactly as the routine row stores it. */
  readonly expression: string;
  /** Minutes 0–59, ascending and deduplicated. */
  readonly minutes: readonly number[];
  /** Hours 0–23, ascending and deduplicated. */
  readonly hours: readonly number[];
  /** Days of the month 1–31, ascending and deduplicated. */
  readonly daysOfMonth: readonly number[];
  /** Months 1–12, ascending and deduplicated. */
  readonly months: readonly number[];
  /** Days of the week 0–6 with Sunday as 0, ascending and deduplicated. */
  readonly daysOfWeek: readonly number[];
  /** True when the day-of-month field covers 1–31, so it constrains nothing. */
  readonly dayOfMonthUnrestricted: boolean;
  /** True when the day-of-week field covers 0–6, so it constrains nothing. */
  readonly dayOfWeekUnrestricted: boolean;
}

export class RoutineScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineScheduleError";
  }
}

/** The expression is not one this parser accepts. */
export class InvalidRoutineCron extends RoutineScheduleError {
  readonly expression: string;

  constructor(expression: string, detail: string) {
    super(`The routine cron expression "${expression}" is invalid: ${detail}`);
    this.name = "InvalidRoutineCron";
    this.expression = expression;
  }
}

/** The timezone name is not an IANA zone this runtime knows. */
export class InvalidRoutineTimezone extends RoutineScheduleError {
  readonly timezone: string;

  constructor(timezone: string) {
    super(`The routine timezone "${timezone}" is not an IANA timezone this runtime knows`);
    this.name = "InvalidRoutineTimezone";
    this.timezone = timezone;
  }
}

/**
 * A syntactically valid expression with no fire time in the horizon — a real
 * possibility (`0 0 31 2 *`, February 31) rather than a defect, so it is a
 * typed error the operator can see instead of a scheduler that waits forever.
 */
export class UnreachableRoutineSchedule extends RoutineScheduleError {
  readonly expression: string;
  readonly timezone: string;

  constructor(expression: string, timezone: string) {
    super(
      `The routine cron expression "${expression}" has no fire time in the next eight years ` +
        `in "${timezone}"`,
    );
    this.name = "UnreachableRoutineSchedule";
    this.expression = expression;
    this.timezone = timezone;
  }
}

/** The scheduler's decision for one due routine; `wait` means the slot is still ahead. */
export type RoutineDueDecision =
  | {
      readonly action: "fire";
      readonly scheduledFor: Date;
      readonly nextRunAt: Date;
      readonly lateByMs: number;
    }
  | {
      readonly action: "miss";
      readonly scheduledFor: Date;
      readonly nextRunAt: Date;
      readonly lateByMs: number;
    }
  | { readonly action: "wait"; readonly nextRunAt: Date };

export interface RoutineDueInput {
  readonly cron: RoutineCron;
  readonly timezone: string;
  /** The slot the routine row is waiting on. */
  readonly nextRunAt: Date;
  /** The database's clock, so the decision never trusts the host's. */
  readonly now: Date;
}

/**
 * What to do with the slot a routine is waiting on.
 *
 * A slot at most `ROUTINE_MISS_GRACE_MS` late is fired; the schedule then
 * advances to the slot's immediate successor, so a pass that was late by more
 * than one interval catches up one run per tick instead of skipping wall-clock
 * times. A slot older than the grace is recorded missed and the schedule jumps
 * to the first fire after `now`, because replaying a downtime as a burst of
 * stale runs is worse than showing the operator that the schedule was missed.
 */
export function decideRoutineDue(input: RoutineDueInput): RoutineDueDecision {
  const { cron, timezone, nextRunAt, now } = input;
  const lateByMs = now.getTime() - nextRunAt.getTime();

  if (lateByMs < 0) {
    return { action: "wait", nextRunAt };
  }

  if (lateByMs <= ROUTINE_MISS_GRACE_MS) {
    return {
      action: "fire",
      scheduledFor: nextRunAt,
      nextRunAt: nextRoutineFire(cron, timezone, nextRunAt),
      lateByMs,
    };
  }

  return {
    action: "miss",
    scheduledFor: nextRunAt,
    nextRunAt: nextRoutineFire(cron, timezone, now),
    lateByMs,
  };
}

/** Parses the five fields; every sentence of the grammar throws `InvalidRoutineCron`. */
export function parseRoutineCron(expression: string): RoutineCron {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== ROUTINE_CRON_FIELDS.length) {
    throw new InvalidRoutineCron(
      expression,
      `expected ${ROUTINE_CRON_FIELDS.length} fields (${ROUTINE_CRON_FIELDS.join(", ")}) ` +
        `but found ${fields.length}`,
    );
  }

  const [minuteText, hourText, dayOfMonthText, monthText, dayOfWeekText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(expression, minuteText, "minute", 0, 59, undefined);
  const hours = parseField(expression, hourText, "hour", 0, 23, undefined);
  const daysOfMonth = parseField(expression, dayOfMonthText, "day of month", 1, 31, undefined);
  const months = parseField(expression, monthText, "month", 1, 12, MONTH_NAMES);
  const parsedDaysOfWeek = parseField(
    expression,
    dayOfWeekText,
    "day of week",
    0,
    7,
    WEEKDAY_NAMES,
  );
  // 7 and 0 are both Sunday; the set normalizes them to 0, so `0-7` covers
  // every weekday and is unrestricted exactly as `*` is.
  const daysOfWeek = [
    ...new Set(parsedDaysOfWeek.values.map((value) => (value === 7 ? 0 : value))),
  ].sort((left, right) => left - right);

  return {
    expression,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek,
    dayOfMonthUnrestricted: daysOfMonth.values.length === 31,
    dayOfWeekUnrestricted: daysOfWeek.length === 7,
  };
}

/** True when the runtime can resolve this IANA timezone. */
export function isRoutineTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first instant strictly after `after` whose local wall clock matches the
 * schedule in `timezone`.
 *
 * The search walks local calendar days, then the schedule's hours and minutes
 * in ascending order; each candidate local time is resolved to an instant
 * through `resolveWallClock`, which is where the DST policies above live. A
 * valid expression with no match in eight years throws
 * `UnreachableRoutineSchedule` rather than searching forever.
 */
export function nextRoutineFire(cron: RoutineCron, timezone: string, after: Date): Date {
  const afterMs = after.getTime();
  if (Number.isNaN(afterMs)) {
    throw new RoutineScheduleError("The routine schedule needs a valid date to search from");
  }

  if (!isRoutineTimezone(timezone)) {
    throw new InvalidRoutineTimezone(timezone);
  }

  // The first whole local minute after the caller's instant; a fire is always
  // at a wall-clock minute, and "strictly after" starts here rather than at
  // `after + 60s`, which a DST transition would move.
  const startWall = Math.floor(wallClockAt(afterMs, timezone) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const startDay = Math.floor(startWall / DAY_MS) * DAY_MS;

  for (let dayOffset = 0; dayOffset <= MAX_FIRE_HORIZON_DAYS; dayOffset += 1) {
    const wall = startDay + dayOffset * DAY_MS;
    const year = new Date(wall).getUTCFullYear();
    const month = new Date(wall).getUTCMonth() + 1;
    const day = new Date(wall).getUTCDate();

    if (!cron.months.includes(month) || !dayMatches(cron, year, month, day)) {
      continue;
    }

    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const candidateWall = Date.UTC(year, month - 1, day, hour, minute);
        if (candidateWall < startWall) {
          continue;
        }

        const instant = resolveWallClock(candidateWall, timezone);

        if (instant.getTime() > afterMs) {
          return instant;
        }
      }
    }
  }

  throw new UnreachableRoutineSchedule(cron.expression, timezone);
}

/**
 * Resolves one local wall-clock minute to an instant.
 *
 * Two candidate instants are tested — the wall time minus the offset a day
 * before and a day after — and the search starts at the earlier one and walks
 * forward a minute at a time until the zone's local clock reaches the
 * requested wall time. That single walk implements both DST policies: a
 * normal time stops at the exact instant; an ambiguous time stops at the first
 * occurrence; and a nonexistent time stops at the transition instant, where
 * the clock first passes it.
 */
function resolveWallClock(wall: number, timezone: string): Date {
  const before = wall - offsetAt(wall - DAY_MS, timezone);
  const after = wall - offsetAt(wall + DAY_MS, timezone);
  let candidate = Math.min(before, after);

  for (let step = 0; step <= MAX_WALL_CLOCK_SHIFT_MINUTES; step += 1) {
    if (wallClockAt(candidate, timezone) >= wall) {
      return new Date(candidate);
    }

    candidate += MINUTE_MS;
  }

  throw new RoutineScheduleError(
    `The timezone "${timezone}" moved its clock more than two days at once; refusing to guess`,
  );
}

/** The zone's offset from UTC, in milliseconds, at one instant. */
function offsetAt(instantMs: number, timezone: string): number {
  return wallClockAt(instantMs, timezone) - instantMs;
}

/** An instant's local wall clock, encoded as the UTC milliseconds a calendar would show. */
function wallClockAt(instantMs: number, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;

    if (value === undefined) {
      throw new RoutineScheduleError(`The timezone "${timezone}" formatted no ${type}`);
    }

    return Number(value);
  };

  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per zone, cached: constructing an `Intl.DateTimeFormat` is the
 * expensive part of resolving a time, and a routine fires the same zone
 * thousands of times in a suite. An unknown zone throws here, which is how
 * `isRoutineTimezone` answers.
 */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);

  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, formatter);
  }

  return formatter;
}

/**
 * The cron day rule: a field covering its whole range imposes nothing, and when
 * both day fields constrain, a day matches if either matches.
 */
function dayMatches(cron: RoutineCron, year: number, month: number, day: number): boolean {
  const dayOfMonth = cron.daysOfMonth.includes(day);
  const dayOfWeek = cron.daysOfWeek.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());

  if (cron.dayOfMonthUnrestricted && cron.dayOfWeekUnrestricted) {
    return true;
  }

  if (cron.dayOfMonthUnrestricted) {
    return dayOfWeek;
  }

  if (cron.dayOfWeekUnrestricted) {
    return dayOfMonth;
  }

  return dayOfMonth || dayOfWeek;
}

interface ParsedField {
  readonly values: readonly number[];
}

function parseField(
  expression: string,
  text: string,
  field: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> | undefined,
): ParsedField {
  const values = new Set<number>();

  for (const part of text.split(",")) {
    if (part === "") {
      throw new InvalidRoutineCron(expression, `the ${field} field has an empty list element`);
    }

    parsePart(expression, part, field, minimum, maximum, names, values);
  }

  if (values.size === 0) {
    throw new InvalidRoutineCron(expression, `the ${field} field matches no value`);
  }

  return { values: [...values].sort((left, right) => left - right) };
}

function parsePart(
  expression: string,
  part: string,
  field: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> | undefined,
  values: Set<number>,
): void {
  const slash = part.indexOf("/");
  const base = slash === -1 ? part : part.slice(0, slash);
  const step = slash === -1 ? 1 : parseStep(expression, part.slice(slash + 1), field);

  if (base === "*") {
    for (let value = minimum; value <= maximum; value += step) {
      values.add(value);
    }

    return;
  }

  const dash = base.indexOf("-");

  if (dash !== -1) {
    const start = parseValue(expression, base.slice(0, dash), field, minimum, maximum, names);
    const end = parseValue(expression, base.slice(dash + 1), field, minimum, maximum, names);

    if (start > end) {
      throw new InvalidRoutineCron(
        expression,
        `the ${field} range "${base}" starts above the value it ends at`,
      );
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }

    return;
  }

  const value = parseValue(expression, base, field, minimum, maximum, names);

  if (slash !== -1) {
    // `7/10` has no meaning the codebase should guess at; write `7-59/10`.
    throw new InvalidRoutineCron(
      expression,
      `the ${field} step "${part}" needs a range or "*", as in "*/${step}" or "1-30/${step}"`,
    );
  }

  values.add(value);
}

function parseStep(expression: string, text: string, field: string): number {
  if (!/^\d+$/.test(text)) {
    throw new InvalidRoutineCron(expression, `the ${field} step "${text}" is not a number`);
  }

  const step = Number(text);

  if (step < 1) {
    throw new InvalidRoutineCron(expression, `the ${field} step must be at least 1`);
  }

  return step;
}

function parseValue(
  expression: string,
  text: string,
  field: string,
  minimum: number,
  maximum: number,
  names: Readonly<Record<string, number>> | undefined,
): number {
  const named = names?.[text.toUpperCase()];
  const value = named ?? (/^\d+$/.test(text) ? Number(text) : Number.NaN);

  if (Number.isNaN(value)) {
    throw new InvalidRoutineCron(expression, `the ${field} value "${text}" is not a value or name`);
  }

  if (value < minimum || value > maximum) {
    throw new InvalidRoutineCron(
      expression,
      `the ${field} value "${text}" is outside ${minimum}-${maximum}`,
    );
  }

  return value;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

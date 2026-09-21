import {
  InvalidRoutineCron,
  InvalidRoutineTimezone,
  isRoutineTimezone,
  nextRoutineFire,
  parseRoutineCron,
  UnreachableRoutineSchedule,
} from "@porkbot/core";
import type { Routine, RoutineOutcome } from "@porkbot/contracts";

/** The schedule fields shared by create, edit and the preview request. */
export interface RoutineScheduleInput {
  readonly instruction: string;
  readonly cron: string;
  readonly timezone: string;
}

/** The patch the editor can send for a live routine. */
export interface RoutineUpdateInput {
  readonly id: string;
  readonly instruction?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly enabled?: boolean;
}

export interface RoutineTestRunResult {
  readonly runId: string;
  readonly threadId: string;
}

/** The web surface's narrow seam over the routines contract. */
export interface RoutinesTransport {
  list(botId: string): Promise<readonly Routine[]>;
  create(input: RoutineScheduleInput & { readonly botId: string }): Promise<Routine>;
  update(input: RoutineUpdateInput): Promise<Routine>;
  remove(id: string): Promise<{ readonly id: string }>;
  preview(input: {
    readonly cron: string;
    readonly timezone: string;
    readonly count?: number;
  }): Promise<readonly string[]>;
  testRun(input: {
    readonly id: string;
    readonly clientNonce: string;
  }): Promise<RoutineTestRunResult>;
  outcomes(input: {
    readonly id: string;
    readonly limit?: number;
  }): Promise<readonly RoutineOutcome[]>;
}

export interface RoutinePreviewState {
  readonly status: "idle" | "loading" | "ready" | "refused";
  readonly fireTimes: readonly string[];
  readonly message: string | null;
}

/**
 * A short, human-readable version of the schedule operators see on a card.
 * The raw expression remains available in the editor, but the list should
 * answer "when does this run?" without making the operator parse cron.
 */
export function describeRoutineSchedule(cron: string, timezone: string): string {
  try {
    const parsed = parseRoutineCron(cron);
    const minute = parsed.minutes[0];
    const hour = parsed.hours[0];
    const everyMinute = parsed.minutes.length === 60;
    const everyHour = parsed.hours.length === 24;
    const everyDay = parsed.dayOfMonthUnrestricted && parsed.dayOfWeekUnrestricted;
    const dayText = describeDays(parsed.daysOfWeek);

    if (everyMinute && everyHour && everyDay) {
      return `Every minute · ${timezone}`;
    }

    if (everyHour && everyDay && minute !== undefined) {
      const step = constantStep(parsed.minutes);

      return step === null
        ? `Every hour at :${String(minute).padStart(2, "0")} · ${timezone}`
        : `Every ${String(step)} minutes · ${timezone}`;
    }

    if (minute !== undefined && hour !== undefined && everyDay) {
      const time = formatClockTime(hour, minute);

      if (dayText === null) {
        return `Daily at ${time} · ${timezone}`;
      }

      return `${dayText} at ${time} · ${timezone}`;
    }

    if (minute !== undefined && hour !== undefined && dayText !== null) {
      return `${dayText} at ${formatClockTime(hour, minute)} · ${timezone}`;
    }

    if (minute !== undefined && hour !== undefined) {
      return `At ${formatClockTime(hour, minute)} · ${timezone}`;
    }

    return `On the configured schedule · ${timezone}`;
  } catch {
    return `On the configured schedule · ${timezone}`;
  }
}

function constantStep(values: readonly number[]): number | null {
  if (values.length < 2 || values[0] !== 0) {
    return null;
  }

  const step = (values[1] ?? 0) - (values[0] ?? 0);

  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];

    if (previous === undefined || current === undefined || current - previous !== step) {
      return null;
    }
  }

  if (step < 1) {
    return null;
  }

  return step;
}

function describeDays(days: readonly number[]): string | null {
  if (days.length === 0 || days.length === 7) {
    return null;
  }

  if (days.length === 5 && days.every((day, index) => day === index + 1)) {
    return "Weekdays";
  }

  if (days.length === 2 && days.includes(0) && days.includes(6)) {
    return "Weekends";
  }

  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return `On ${days.map((day) => names[day] ?? `day ${String(day)}`).join(", ")}`;
}

function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Gives the editor a useful field-level explanation even though the transport
 * deliberately redacts the scheduler's detailed server error at the API
 * boundary. The local parser is the same core implementation the scheduler
 * uses, and the fallback still tells the operator what to change.
 */
export function routineScheduleErrorMessage(
  cron: string,
  timezone: string,
  error?: unknown,
): string | null {
  if (cron.trim() === "" || timezone.trim() === "") {
    return null;
  }

  let parsed: ReturnType<typeof parseRoutineCron>;

  try {
    parsed = parseRoutineCron(cron);
  } catch (candidate) {
    if (candidate instanceof InvalidRoutineCron) {
      return `Use a valid five-field cron expression. ${candidate.message}`;
    }

    return "Use a valid five-field cron expression.";
  }

  if (!isRoutineTimezone(timezone)) {
    return "Use an IANA timezone such as UTC or Europe/Lisbon.";
  }

  try {
    nextRoutineFire(parsed, timezone, new Date());
  } catch (candidate) {
    if (candidate instanceof UnreachableRoutineSchedule) {
      return "This schedule has no fire time in the scheduler's eight-year horizon. Choose a date that can occur.";
    }
  }

  if (error instanceof InvalidRoutineCron) {
    return `Use a valid five-field cron expression. ${error.message}`;
  }

  if (error instanceof InvalidRoutineTimezone) {
    return "Use an IANA timezone such as UTC or Europe/Lisbon.";
  }

  return error === undefined
    ? null
    : "The scheduler could not resolve this schedule. Choose another time or timezone.";
}

/** The routine editor's idempotency key for a manual test run. */
export function routineTestRunNonce(): string {
  const randomUuid = globalThis.crypto?.randomUUID;

  if (typeof randomUuid === "function") {
    return `routine-test:${randomUuid.call(globalThis.crypto)}`;
  }

  return `routine-test:${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

/** Status words shared by the card's summary and its occurrence ledger. */
export function routineOutcomeLabel(status: RoutineOutcome["status"]): string {
  switch (status) {
    case "success":
      return "Succeeded";
    case "failure":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "missed":
      return "Missed";
    case "running":
      return "Running";
  }
}

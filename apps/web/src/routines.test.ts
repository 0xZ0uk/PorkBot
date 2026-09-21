import {
  InvalidRoutineCron,
  InvalidRoutineTimezone,
  UnreachableRoutineSchedule,
} from "@porkbot/core";
import { describe, expect, it } from "vitest";
import {
  describeRoutineSchedule,
  routineOutcomeLabel,
  routineScheduleErrorMessage,
  routineTestRunNonce,
} from "./routines.ts";

describe("routine display helpers", () => {
  it("turns a weekday cron expression into words", () => {
    expect(describeRoutineSchedule("0 9 * * 1-5", "UTC")).toBe("Weekdays at 09:00 · UTC");
    expect(describeRoutineSchedule("0 9 * * *", "Europe/Lisbon")).toBe(
      "Daily at 09:00 · Europe/Lisbon",
    );
    expect(describeRoutineSchedule("*/5 * * * *", "UTC")).toBe("Every 5 minutes · UTC");
  });

  it("names the schedule reason the editor can correct", () => {
    expect(routineScheduleErrorMessage("not cron", "UTC")).toContain(
      "valid five-field cron expression",
    );
    expect(routineScheduleErrorMessage("0 9 * * *", "Mars/Olympus_Mons")).toContain(
      "IANA timezone",
    );
    expect(
      routineScheduleErrorMessage(
        "0 0 31 2 *",
        "UTC",
        new UnreachableRoutineSchedule("0 0 31 2 *", "UTC"),
      ),
    ).toContain("no fire time");
  });

  it("retains useful messages for core schedule errors", () => {
    expect(
      routineScheduleErrorMessage("0 25 * * *", "UTC", new InvalidRoutineCron("x", "bad")),
    ).toContain("valid five-field cron expression");
    expect(
      routineScheduleErrorMessage("0 9 * * *", "UTC", new InvalidRoutineTimezone("bad")),
    ).toContain("IANA timezone");
  });

  it("keeps outcome words explicit and test-run nonces unique in shape", () => {
    expect(routineOutcomeLabel("success")).toBe("Succeeded");
    expect(routineOutcomeLabel("missed")).toBe("Missed");
    expect(routineTestRunNonce()).toMatch(/^routine-test:/);
  });
});

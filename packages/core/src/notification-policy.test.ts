import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isNotificationKind,
  NOTIFICATION_KINDS,
  resolveNotificationPreferences,
  shouldNotify,
} from "./notification-policy.ts";

/**
 * The quiet-by-default rule, asserted before anything can rely on it: a fresh
 * operator is interrupted by nothing, a stored row turns exactly one kind on,
 * and an unknown row is ignored rather than breaking the reader.
 */
describe("notification preferences", () => {
  it("defaults every kind off, the quiet direction", () => {
    expect(Object.values(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual([false, false, false, false]);

    for (const kind of NOTIFICATION_KINDS) {
      expect(shouldNotify(DEFAULT_NOTIFICATION_PREFERENCES, kind), kind).toBe(false);
    }
  });

  it("recognises exactly the kinds it names", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isNotificationKind(kind)).toBe(true);
    }

    expect(isNotificationKind("run.started")).toBe(false);
    expect(isNotificationKind("")).toBe(false);
  });

  it("lays stored rows over the defaults without requiring every kind", () => {
    const resolved = resolveNotificationPreferences([{ kind: "run.failed", enabled: true }]);

    expect(resolved).toEqual({
      "run.completed": false,
      "run.failed": true,
      "run.needs_approval": false,
      "run.stalled": false,
    });
    expect(shouldNotify(resolved, "run.failed")).toBe(true);
    expect(shouldNotify(resolved, "run.completed")).toBe(false);
  });

  it("honours an explicit off over an earlier on in row order", () => {
    const resolved = resolveNotificationPreferences([
      { kind: "run.stalled", enabled: true },
      { kind: "run.stalled", enabled: false },
    ]);

    expect(resolved["run.stalled"]).toBe(false);
  });

  it("ignores a stored kind this version does not know", () => {
    const resolved = resolveNotificationPreferences([
      { kind: "run.teleported" as never, enabled: true },
    ]);

    expect(resolved).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});

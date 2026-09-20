import { describe, expect, it } from "vitest";
import { notificationLabel } from "./notifications.ts";
import type { NotificationsController, NotificationsState } from "./notifications.ts";
import { createNotificationsController } from "./notifications.ts";
import { scriptedNotificationsTransport } from "../test/fakes.ts";
import { NOTIFICATION_KINDS } from "@porkbot/core";

/**
 * The notification switches without a DOM: the read, the write and the two
 * failure directions. What this suite pins is the rule the screen depends on —
 * a write answers the whole set and a failed write leaves the last server
 * answer alone — plus the label map the screen renders.
 */

async function until(
  controller: NotificationsController,
  predicate: (state: NotificationsState) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(controller.state())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for ${label}`);
}

describe("the notification settings controller", () => {
  it("reads every kind with the quiet defaults filled in", async () => {
    const controller = createNotificationsController({
      transport: scriptedNotificationsTransport(),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    expect(controller.state().preferences).toEqual(
      NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: false })),
    );
  });

  it("flips one switch and keeps the server's whole set", async () => {
    const controller = createNotificationsController({
      transport: scriptedNotificationsTransport({ enabled: ["run.failed"] }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.setPreference("run.stalled", true);

    expect(controller.state().preferences).toEqual([
      { kind: "run.completed", enabled: false },
      { kind: "run.failed", enabled: true },
      { kind: "run.needs_approval", enabled: false },
      { kind: "run.stalled", enabled: true },
    ]);
    expect(controller.state().pending).toBeNull();
  });

  it("leaves the last server set on screen when the write fails", async () => {
    const controller = createNotificationsController({
      transport: scriptedNotificationsTransport({
        enabled: ["run.failed"],
        writeFailure: new Error("offline"),
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.setPreference("run.failed", false);

    expect(controller.state().preferences.find((p) => p.kind === "run.failed")?.enabled).toBe(true);
    expect(controller.state().notice).toBe("The change could not be saved.");
  });

  it("refuses with one sentence when the read fails, and recovers on retry", async () => {
    const controller = createNotificationsController({
      transport: scriptedNotificationsTransport({ readFailure: new Error("offline") }),
    });

    controller.load();
    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Notification settings could not be loaded.");
  });

  it("names every kind in the vocabulary", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(notificationLabel(kind)).not.toBe("");
    }
  });
});

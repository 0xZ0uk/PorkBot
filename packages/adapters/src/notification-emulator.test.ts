import { createNotificationDelivery } from "@porkbot/effect";
import type { NotificationEligibility, NotificationRecipients } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { NotificationEmulator } from "./index.ts";
import { notificationConformance } from "./notification-conformance.ts";

/**
 * The emulator's own behaviours beyond the shared conformance suite: a
 * deterministic sequence a test can assert by position, the mailbox accessors
 * tests read between cases, and the destructive projection that keeps a field
 * the interface does not name out of the delivered record.
 */
describe("the notification emulator", () => {
  it("numbers receipts deterministically from one", async () => {
    const emulator = new NotificationEmulator();

    const first = await emulator.deliver({ title: "Run failed", body: "First." });
    const second = await emulator.deliver({ title: "Run failed", body: "Second." });

    expect(first).toEqual({ id: "notification-1" });
    expect(second).toEqual({ id: "notification-2" });
    expect(emulator.mailbox.map((delivered) => delivered.sequence)).toEqual([1, 2]);
  });

  it("reads the newest delivery and empties on clear", async () => {
    const emulator = new NotificationEmulator();

    expect(emulator.last()).toBeUndefined();
    expect(emulator.size).toBe(0);

    await emulator.deliver({ title: "Run stalled", body: "No progress." });

    expect(emulator.last()?.title).toBe("Run stalled");
    expect(emulator.size).toBe(1);

    emulator.clear();

    expect(emulator.size).toBe(0);
    expect(emulator.deliveries()).toEqual([]);
  });

  it("records the link only when there is one", async () => {
    const emulator = new NotificationEmulator();

    await emulator.deliver({ title: "Run failed", body: "No link." });
    await emulator.deliver({
      title: "Run failed",
      body: "With link.",
      url: "https://example.invalid",
    });

    expect(emulator.mailbox[0]).not.toHaveProperty("url");
    expect(emulator.mailbox[1]?.url).toBe("https://example.invalid");
  });

  it("is the delivery path's provider with no key and no network", async () => {
    const emulator = new NotificationEmulator();
    const eligibility: NotificationEligibility = "enabled";
    const recipients: NotificationRecipients = {
      eligibility: () => Promise.resolve(eligibility),
    };
    const delivery = createNotificationDelivery({ provider: emulator, recipients });

    await expect(
      delivery.deliver({
        recipientUserId: "user-1",
        kind: "run.failed",
        title: "Run failed",
        body: "The nightly report run failed.",
      }),
    ).resolves.toEqual({ status: "delivered", receiptId: "notification-1", attempts: 1 });

    expect(emulator.last()).toMatchObject({
      title: "Run failed",
      body: "The nightly report run failed.",
    });
  });
});

notificationConformance("the emulator", () => {
  const emulator = new NotificationEmulator();

  return Promise.resolve({
    provider: emulator,
    delivered: () => emulator.mailbox.map((delivered) => ({ ...delivered })),
  });
});

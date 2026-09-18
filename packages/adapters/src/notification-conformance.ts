import type { NotificationProvider, OperatorNotification } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";

/**
 * The notification conformance suite (slice 8.6): one set of behaviors every
 * `NotificationProvider` implementation must show, run against the offline
 * emulator and against the HTTP provider over the wire emulator's loopback
 * server. An implementation that drifts from the seam — a payload the
 * destination never receives, a link smuggled as an empty string, a second
 * delivery reusing the first receipt, a field the interface does not name
 * riding along beside the title and body — fails here rather than in the
 * lifecycle that notifications interrupt.
 *
 * The suite calls no network and holds no real key: the HTTP side dials an
 * in-process server on loopback, which is why the same file can run both. The
 * harness exposes the destination's own record of each accepted delivery, read
 * fresh on every call, not a re-projection, so "the adapter dropped a field it
 * should not have sent" is observable rather than hidden by the harness.
 */

export interface NotificationConformanceHarness {
  readonly provider: NotificationProvider;
  /**
   * The destination's record of each accepted delivery, oldest first: the
   * emulator's mailbox entries and the HTTP wire's parsed request bodies. A
   * function, not an array, so a harness cannot hand out a stale snapshot.
   */
  delivered(): readonly Readonly<Record<string, unknown>>[];
}

export type NotificationConformanceFactory = () => Promise<NotificationConformanceHarness>;

/**
 * The keys an implementation may add beside the interface's own fields: the
 * emulator records a receipt id and a sequence number, and the wire records
 * nothing extra because the receipt is in the response.
 */
const implementationKeys = new Set(["id", "sequence"]);

/** The three fields `OperatorNotification` names; nothing else may reach a destination. */
const notificationFieldNames = new Set(["title", "body", "url"]);

export function notificationConformance(
  name: string,
  create: NotificationConformanceFactory,
): void {
  describe(`${name} notification conformance`, () => {
    const notification: OperatorNotification = {
      title: "Run failed",
      body: "The nightly report run failed while calling the summary tool.",
      url: "https://porkbot.example.invalid/runs/run-42",
    };

    it("delivers a notification and returns a usable receipt", async () => {
      const { provider, delivered } = await create();

      const receipt = await provider.deliver(notification);

      expect(receipt.id.trim()).not.toBe("");
      expect(delivered()).toHaveLength(1);
    });

    it("hands the destination the title, body and link unchanged", async () => {
      const { provider, delivered } = await create();

      await provider.deliver(notification);

      expect(delivered()[0]).toMatchObject({
        title: notification.title,
        body: notification.body,
        url: notification.url,
      });
    });

    it("omits the link when the notification names none", async () => {
      const { provider, delivered } = await create();

      await provider.deliver({ title: "Run finished", body: "The run finished successfully." });

      expect(delivered()[0]).toMatchObject({
        title: "Run finished",
        body: "The run finished successfully.",
      });
      expect(delivered()[0]?.["url"]).toBeUndefined();
    });

    it("gives each delivery its own receipt", async () => {
      const { provider, delivered } = await create();

      const first = await provider.deliver(notification);
      const second = await provider.deliver({ title: "Run failed", body: "A second failure." });

      expect(first.id).not.toBe(second.id);
      expect(delivered()).toHaveLength(2);
    });

    it("sends nothing the interface does not name", async () => {
      const { provider, delivered } = await create();
      const secret = "sk-not-a-real-key-0001";

      // A notification that somehow carries a credential or raw tool arguments
      // beside its title and body: the interface names three fields, and the
      // adapter is the last stop before a third party.
      await provider.deliver({
        title: "Run failed",
        body: "The run failed.",
        arguments: { apiKey: secret },
        credential: secret,
      } as OperatorNotification);

      const record = delivered()[0];

      for (const key of Object.keys(record ?? {})) {
        expect(
          notificationFieldNames.has(key) || implementationKeys.has(key),
          `the destination received a "${key}" the interface does not name`,
        ).toBe(true);
      }

      expect(JSON.stringify(record)).not.toContain(secret);
    });
  });
}

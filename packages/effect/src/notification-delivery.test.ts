import type {
  NotificationProvider,
  NotificationReceipt,
  OperatorNotification,
} from "@porkbot/adapter-kit";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createNotificationDelivery } from "./notification-delivery.ts";
import type {
  NotificationDeliveryOutcome,
  NotificationDeliveryRequest,
} from "./notification-delivery.ts";
import type { NotificationEligibility, NotificationRecipients } from "./notification-store.ts";

/**
 * The delivery path's rules, over a recording provider: preferences gate the
 * call, transient failures retry with bounded backoff, permanent ones surface
 * immediately, and an outcome — never a silent drop — is what comes back.
 */

const request: NotificationDeliveryRequest = {
  recipientUserId: "user-1",
  kind: "run.failed",
  title: "Run failed",
  body: "The nightly report run failed while calling the summary tool.",
  url: "https://porkbot.example.invalid/runs/run-42",
};

function recipients(eligibility: NotificationEligibility): NotificationRecipients {
  return {
    eligibility: () => Promise.resolve(eligibility),
  };
}

interface RecordingProvider extends NotificationProvider {
  readonly delivered: readonly OperatorNotification[];
  readonly calls: number;
}

function provider(
  respond: (notification: OperatorNotification, call: number) => Promise<NotificationReceipt>,
): RecordingProvider {
  const delivered: OperatorNotification[] = [];
  let calls = 0;

  return {
    delivered,
    get calls() {
      return calls;
    },
    deliver(notification) {
      calls += 1;
      delivered.push(notification);

      return respond(notification, calls);
    },
  };
}

function failure(kind: "rate_limited" | "timed_out" | "auth_failed" | "not_found"): Error {
  const error = new Error(`provider said ${kind}`) as Error & { readonly kind: string };

  Object.defineProperty(error, "kind", { value: kind, enumerable: true });

  return error;
}

function loggerLines(): {
  readonly lines: string[];
  readonly logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];

  return {
    lines,
    logger: createLogger({ service: "@porkbot/effect", write: (line) => lines.push(line) }),
  };
}

describe("notification delivery", () => {
  it("delivers an enabled notification and reports the receipt", async () => {
    const emulatorish = provider((notification) =>
      Promise.resolve({ id: `receipt-${notification.title}` }),
    );
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("enabled"),
    });

    const outcome = await delivery.deliver(request);

    expect(outcome).toEqual({ status: "delivered", receiptId: "receipt-Run failed", attempts: 1 });
    expect(emulatorish.delivered).toEqual([
      { title: request.title, body: request.body, url: request.url },
    ]);
  });

  it("suppresses a preference that is off without asking the provider", async () => {
    const emulatorish = provider(() => Promise.resolve({ id: "never" }));
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("disabled"),
    });

    const outcome = await delivery.deliver(request);

    expect(outcome).toEqual({ status: "suppressed", reason: "preference" });
    expect(emulatorish.calls).toBe(0);
  });

  it("suppresses a recipient outside the space without asking the provider", async () => {
    const emulatorish = provider(() => Promise.resolve({ id: "never" }));
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("not_a_recipient"),
    });

    const outcome = await delivery.deliver(request);

    expect(outcome).toEqual({ status: "suppressed", reason: "not_a_recipient" });
    expect(emulatorish.calls).toBe(0);
  });

  it("retries a rate-limited and a timed-out failure with bounded backoff, then delivers", async () => {
    const sleeps: number[] = [];
    const emulatorish = provider((_notification, call) => {
      if (call === 1) {
        return Promise.reject(failure("rate_limited"));
      }

      if (call === 2) {
        return Promise.reject(failure("timed_out"));
      }

      return Promise.resolve({ id: "receipt-3" });
    });
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("enabled"),
      backoff: {
        policy: { baseDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0 },
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);

        return Promise.resolve();
      },
    });

    const outcome = await delivery.deliver(request);

    expect(outcome).toEqual({ status: "delivered", receiptId: "receipt-3", attempts: 3 });
    expect(sleeps).toEqual([100, 200]);
  });

  it("gives up after the attempt bound and surfaces the undelivered outcome", async () => {
    const { lines, logger } = loggerLines();
    const outcomes: NotificationDeliveryOutcome[] = [];
    const emulatorish = provider(() => Promise.reject(failure("timed_out")));
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("enabled"),
      logger,
      maxAttempts: 2,
      backoff: { policy: { baseDelayMs: 10, maxDelayMs: 10, multiplier: 1, jitterRatio: 0 } },
      sleep: () => Promise.resolve(),
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    const outcome = await delivery.deliver(request);

    expect(outcome).toMatchObject({
      status: "undelivered",
      failureKind: "timed_out",
      attempts: 2,
    });
    expect(emulatorish.calls).toBe(2);
    expect(outcomes).toEqual([outcome]);
    expect(lines.some((line) => line.includes("notification undelivered"))).toBe(true);
  });

  it("does not retry a permanent failure", async () => {
    for (const kind of ["auth_failed", "not_found"] as const) {
      const emulatorish = provider(() => Promise.reject(failure(kind)));
      const delivery = createNotificationDelivery({
        provider: emulatorish,
        recipients: recipients("enabled"),
        sleep: () => Promise.reject(new Error("a permanent failure must not sleep")),
      });

      const outcome = await delivery.deliver(request);

      expect(outcome).toMatchObject({ status: "undelivered", failureKind: kind, attempts: 1 });
      expect(emulatorish.calls).toBe(1);
    }
  });

  it("rethrows a failure that is not a classified provider failure", async () => {
    const emulatorish = provider(() => Promise.reject(new Error("a bug in the adapter")));
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("enabled"),
    });

    await expect(delivery.deliver(request)).rejects.toThrow("a bug in the adapter");
  });

  it("omits the link key when the request names none", async () => {
    const emulatorish = provider(() => Promise.resolve({ id: "receipt" }));
    const delivery = createNotificationDelivery({
      provider: emulatorish,
      recipients: recipients("enabled"),
    });

    await delivery.deliver({
      recipientUserId: "user-1",
      kind: "run.completed",
      title: "Done",
      body: "Done.",
    });

    expect(emulatorish.delivered[0]).toEqual({ title: "Done", body: "Done." });
    expect(Object.keys(emulatorish.delivered[0] ?? {})).not.toContain("url");
  });

  it("refuses an attempt bound below one", () => {
    expect(() =>
      createNotificationDelivery({
        provider: provider(() => Promise.resolve({ id: "receipt" })),
        recipients: recipients("enabled"),
        maxAttempts: 0,
      }),
    ).toThrow(/maxAttempts/);
  });
});

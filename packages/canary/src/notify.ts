import type { NotificationProvider, OperatorNotification } from "@porkbot/adapter-kit";
import {
  createEnvironmentCredentialStore,
  createHttpNotificationProvider,
  NotificationEmulator,
} from "@porkbot/adapters";

/**
 * The canary's notification target (slice 12.6): the E8 provider, wired the
 * same way the worker wires it.
 *
 * A canary failure is an operator alert, not a test log line, so it takes the
 * product's delivery path: the offline emulator when no destination is
 * configured (the loud part is then the caller's error log), or the HTTPS
 * webhook whose credential is read through the generic environment credential
 * store under a fixed name. The canary names no vendor here; a webhook is a
 * webhook.
 *
 * The payload is the E8 payload and nothing else — a title, one paragraph and
 * an optional link — because the adapter is the last stop before a third
 * party, and the conformance suite is what proves nothing else can ride along.
 */

/**
 * The credential the HTTP provider reads from the environment by name. It is
 * written at the call site (the shape the `env` tier's auditor reads) and
 * documented in the package's schema.
 */

export interface CanaryNotificationEnvironment {
  readonly [name: string]: string | undefined;
}

export interface CanaryNotificationTarget {
  readonly provider: NotificationProvider;
  readonly destination: "webhook" | "emulator";
}

export interface CanaryNotificationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Picks the delivery provider from the environment; unset means the emulator. */
export function resolveCanaryNotificationTarget(
  env: CanaryNotificationEnvironment,
  logger?: CanaryNotificationLogger,
): CanaryNotificationTarget {
  const webhookUrl = env["PORKBOT_NOTIFICATION_WEBHOOK_URL"]?.trim() ?? "";

  if (webhookUrl === "") {
    logger?.info("no notification webhook configured; a canary failure stays on the error log", {});

    return { provider: new NotificationEmulator(), destination: "emulator" };
  }

  return {
    provider: createHttpNotificationProvider({
      endpoint: webhookUrl,
      credentialName: "PORKBOT_NOTIFICATION_WEBHOOK_KEY",
      credentials: createEnvironmentCredentialStore(env),
    }),
    destination: "webhook",
  };
}

/** Delivers one notification through the target, re-raising a refused delivery. */
export async function deliverCanaryNotification(
  target: CanaryNotificationTarget,
  notification: OperatorNotification,
): Promise<void> {
  await target.provider.deliver(notification);
}

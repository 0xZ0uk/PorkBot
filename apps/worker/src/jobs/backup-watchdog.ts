import type { NotificationProvider } from "@porkbot/adapter-kit";
import { decideBackupAlerts } from "@porkbot/core";
import type { BackupAlert, BackupAlertKind } from "@porkbot/core";
import { createBackupStatusReader } from "@porkbot/db";
import type { BackupStatusReader, Queryable } from "@porkbot/db";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext, JobDefinition } from "../job-registry.ts";

/**
 * The backup watchdog (slice 12.3; PRD story 5).
 *
 * The backup process writes the ledger; this five-minute job is what makes
 * "they do not run" loud. It reads the deployment-scoped ledger — no space, no
 * actor, because a backup covers the whole database — and asks `@porkbot/core`
 * whether anything is alert-worthy: a failed run, a run stuck past any
 * plausible duration, a success gap past the staleness window, a drill that
 * failed or never succeeded. The episode claim the store writes is what keeps
 * one fact to one message even if two workers deliver the job at once.
 *
 * The alert is delivered through the same provider the run notifications use,
 * but without a recipient check: deployment health is not a per-user
 * preference, and there is no space a recipient could belong to. The provider
 * is the adapter-kit seam, so the offline emulator holds the alert with
 * nothing configured and the log line is the loud part; a configured webhook
 * pages the operator.
 *
 * A read or a claim that fails is logged and retried on the next tick. A
 * delivery failure is logged too: the episode is already claimed, so a broken
 * notifier loses this message rather than replaying it forever.
 */

export const backupWatchdogIdentifier = "backup.watchdog";

/** The payload carries nothing; the `_cron` marker Graphile adds is tolerated. */
export type BackupWatchdogPayload = Record<never, never>;

export function parseBackupWatchdogPayload(payload: unknown): BackupWatchdogPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadError(backupWatchdogIdentifier, "must be an object");
  }

  for (const key of Object.keys(payload)) {
    if (key !== "_cron") {
      throw new JobPayloadError(
        backupWatchdogIdentifier,
        `carries "${key}"; the backup watchdog addresses no entity and never carries work`,
      );
    }
  }

  return {};
}

export interface BackupWatchdogOptions {
  /** The notification provider; absent, alerts are recorded and logged only. */
  readonly alerts?: NotificationProvider;
  /** The ledger reader; a suite injects its own over a fake client. */
  readonly reader?: (client: Queryable) => BackupStatusReader;
  readonly now?: () => Date;
}

interface AlertMessage {
  readonly title: string;
  readonly body: string;
}

/** The operator-facing sentence per alert kind; never a ledger field. */
function alertMessage(alert: BackupAlert): AlertMessage {
  switch (alert.kind) {
    case "backup.failed":
      return {
        title: "A backup run failed",
        body: "The newest backup run did not finish. The ledger records the reason code.",
      };
    case "backup.stalled":
      return {
        title: "A backup run is stuck",
        body: "The newest backup run has been running far longer than a backup takes and has not settled.",
      };
    case "backup.missed":
      return {
        title: "Backups have not run",
        body:
          alert.episode === "never"
            ? "No backup has ever succeeded on this deployment."
            : "No backup has succeeded within the expected window.",
      };
    case "drill.failed":
      return {
        title: "A restore drill failed",
        body: "The latest backup did not restore into readable data.",
      };
    case "drill.missed":
      return {
        title: "A restore drill has not run",
        body: "No restore drill has succeeded within the expected window.",
      };
  }
}

async function announce(
  alert: BackupAlert,
  context: JobContext,
  provider: NotificationProvider | undefined,
): Promise<void> {
  if (provider === undefined) {
    context.logger.error("a backup alert has no notification provider configured", {
      kind: alert.kind,
      episode: alert.episode,
    });

    return;
  }

  const message = alertMessage(alert);

  try {
    await provider.deliver({ title: message.title, body: message.body });
    context.logger.warn("a backup alert was delivered", {
      kind: alert.kind,
      episode: alert.episode,
    });
  } catch (error) {
    context.logger.error("could not deliver a backup alert", {
      kind: alert.kind,
      episode: alert.episode,
      error: error instanceof Error ? error.name : "unknown error",
    });
  }
}

export function backupWatchdogJob(
  options: BackupWatchdogOptions = {},
): JobDefinition<BackupWatchdogPayload> {
  const readStatus = options.reader ?? createBackupStatusReader;
  const now = options.now ?? ((): Date => new Date());

  return {
    identifier: backupWatchdogIdentifier,
    parse: parseBackupWatchdogPayload,
    async handle(_payload, context): Promise<void> {
      await context.withPgClient(async (client) => {
        const reader = readStatus(client);
        const status = await reader.status();
        const alerts = decideBackupAlerts({
          now: now(),
          lastRun:
            status.lastRun === undefined
              ? null
              : {
                  status: status.lastRun.status,
                  startedAt: status.lastRun.startedAt,
                  finishedAt: status.lastRun.finishedAt,
                },
          lastSuccessAt: status.lastSuccess?.finishedAt ?? null,
          lastDrillAt: status.lastDrill?.drillFinishedAt ?? null,
          lastDrillRun:
            status.lastDrillRun === undefined
              ? null
              : {
                  status: status.lastDrillRun.drillStatus ?? "running",
                  startedAt: status.lastDrillRun.drillStartedAt ?? status.lastDrillRun.startedAt,
                  finishedAt: status.lastDrillRun.drillFinishedAt,
                },
        });

        if (alerts.length === 0) {
          context.logger.info("backup watchdog pass found nothing to alert", {});

          return;
        }

        for (const alert of alerts) {
          const claimed = await reader.claimAlert(alert.kind, alert.episode);

          if (!claimed) {
            context.logger.debug("a backup alert episode was already announced", {
              kind: alert.kind,
              episode: alert.episode,
            });
            continue;
          }

          await announce(alert, context, options.alerts);
        }
      });
    },
  };
}

/** Every alert kind the watchdog can announce, for the registry's docs. */
export const backupAlertKinds: readonly BackupAlertKind[] = [
  "backup.missed",
  "backup.failed",
  "backup.stalled",
  "drill.missed",
  "drill.failed",
];

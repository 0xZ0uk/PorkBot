import { DEFAULT_BACKUP_SCHEDULE, isBackupDue } from "@porkbot/core";
import type { NightlyBackupSchedule } from "@porkbot/core";
import type { BackupStatus, BackupStatusReader } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";

/**
 * The loop's decision (slice 12.3).
 *
 * A tick asks the ledger when the last attempt started and runs when the next
 * scheduled instant has passed. The ledger is the only cursor — there is no
 * in-memory "next run" that a restart would forget — so a process that was
 * down for two days runs once on boot, not twice, and a process that restarts
 * five minutes after a run does not run again. `force` is the operator's
 * `run` command: it runs whatever the clock says.
 */

export interface BackupSchedulerOptions {
  readonly reader: BackupStatusReader;
  readonly run: (previous: BackupStatus) => Promise<void>;
  readonly schedule?: NightlyBackupSchedule;
  readonly logger: Logger;
  /** The clock seam; defaults to the system clock. */
  readonly now?: () => Date;
}

export interface BackupScheduler {
  /** Runs if due (or forced) and answers what happened. */
  tick(options?: { readonly force?: boolean }): Promise<"ran" | "skipped">;
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const schedule = options.schedule ?? DEFAULT_BACKUP_SCHEDULE;
  const now = options.now ?? ((): Date => new Date());

  return {
    async tick(tickOptions = {}): Promise<"ran" | "skipped"> {
      const previous = await options.reader.status();
      const lastAttemptAt = previous.lastRun?.startedAt ?? null;

      if (tickOptions.force !== true && !isBackupDue(now(), lastAttemptAt, schedule)) {
        options.logger.debug("no backup is due", {});
        return "skipped";
      }

      await options.run(previous);

      return "ran";
    },
  };
}

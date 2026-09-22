/**
 * Whether a Docker daemon can enforce one bot's write-layer disk budget (slice
 * 14.4).
 *
 * `PORKBOT_COMPUTER_DISK_MB` is a number, and the daemon only honors it when a
 * create carries `HostConfig.StorageOpt.size` *and* the storage driver answers
 * that option. Forget either half and the setting is a silent no-op: the
 * container's writable layer grows against the host's disk while the operator
 * believes a ceiling was set. A claim the host cannot keep is worse than no
 * claim, so the driver's answer is detected once and reported — enforced, or
 * explicitly unenforced with the reason — at supervisor boot and in
 * `deploy:check`, never left implicit.
 *
 * The drivers that answer `size` are one list, here, because that is exactly
 * the kind of second-place-decides bug the register prevents. `btrfs` answers
 * it natively (subvolume project quotas); `overlay2` answers it only over an
 * xfs backing filesystem mounted with `pquota` (or `prjquota`); every other
 * driver — `vfs`, `overlay`, `aufs` and `overlay2` over ext4 — refuses the
 * option and Docker then refuses the create. The backing filesystem is read
 * from the daemon's own `/info`, so a driver that reports none is treated as
 * unsupported rather than assumed to be xfs.
 *
 * This module is pure: it classifies a daemon's self-description and decides
 * what a create may carry. `docker-engine.ts` is what reads `/info`, and
 * `docker-computer.ts` is what applies the decision.
 */

/** The two storage drivers that answer a `size` quota, with their condition. */
export const DISK_QUOTA_DRIVERS = [
  {
    driver: "btrfs",
    requirement: "btrfs answers `size` through subvolume project quotas",
  },
  {
    driver: "overlay2",
    requirement: "overlay2 answers `size` only over an xfs backing filesystem mounted with pquota",
  },
] as const;

/** How an operator asked the budget to be enforced. */
export type DiskQuotaMode = "auto" | "none" | "storage-opt";

/** The modes the supervisor accepts, in the order `choice` documents them. */
export const DISK_QUOTA_MODES = ["auto", "none", "storage-opt"] as const;

/**
 * The shipped posture: detect the driver at boot and enforce where it answers.
 * `none` is the explicit opt-out, `storage-opt` the explicit unconditional
 * request (a driver that cannot answer it refuses the create, which is the
 * fail-closed answer for an operator who wants the promise kept or the boot
 * loud).
 */
export const DEFAULT_DISK_QUOTA_MODE: DiskQuotaMode = "auto";

/** What the daemon says about its storage driver. */
export interface DiskQuotaDriverInfo {
  /** The driver's name, for example `overlay2` or `btrfs`. */
  readonly driver: string;
  /** The driver's backing filesystem as `/info` reports it, when it reports one. */
  readonly backingFilesystem?: string | undefined;
}

/** What one daemon's driver can do, independent of the operator's mode. */
export interface DiskQuotaCapability {
  readonly driver: string;
  readonly backingFilesystem: string | undefined;
  /** True only when a create's `size` option will be honored. */
  readonly supported: boolean;
  /** One operator-readable sentence naming the driver and the reason. */
  readonly detail: string;
}

/** The capability plus the operator's mode, resolved to what a create carries. */
export interface DiskQuotaDecision extends DiskQuotaCapability {
  readonly mode: DiskQuotaMode;
  /** True when the create body carries `StorageOpt.size`. */
  readonly applied: boolean;
  /** True when the daemon will actually enforce the budget. */
  readonly enforced: boolean;
}

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Classifies a daemon's storage driver. An unknown or empty driver name is
 * unsupported rather than assumed capable: the budget is only ever claimed
 * where the daemon's own answer says it holds.
 */
export function classifyDiskQuota(info: DiskQuotaDriverInfo): DiskQuotaCapability {
  const driver = normalized(info.driver);
  const backingFilesystem = info.backingFilesystem?.trim().toLowerCase();

  if (driver === "btrfs") {
    return {
      driver,
      backingFilesystem,
      supported: true,
      detail: "btrfs answers a write-layer quota through subvolume project quotas",
    };
  }

  if (driver === "overlay2" && normalized(backingFilesystem) === "xfs") {
    return {
      driver,
      backingFilesystem,
      supported: true,
      detail: "overlay2 over xfs answers a write-layer quota with pquota mounted",
    };
  }

  if (driver === "") {
    return {
      driver,
      backingFilesystem,
      supported: false,
      detail: "the daemon reported no storage driver, so a write-layer quota cannot be promised",
    };
  }

  if (driver === "overlay2") {
    return {
      driver,
      backingFilesystem,
      supported: false,
      detail: `overlay2 answers a write-layer quota only over xfs with pquota; this daemon's backing filesystem is ${backingFilesystem === undefined ? "unreported" : `"${backingFilesystem}"`}`,
    };
  }

  return {
    driver,
    backingFilesystem,
    supported: false,
    detail: `the "${driver}" storage driver does not answer a write-layer quota`,
  };
}

/**
 * Resolves the operator's mode against the driver's capability. `auto` applies
 * the quota exactly when the driver answers it; `storage-opt` applies it
 * unconditionally, so an incapable driver refuses the create rather than
 * quietly ignoring the budget; `none` never applies it and says so.
 */
export function decideDiskQuota(mode: DiskQuotaMode, info: DiskQuotaDriverInfo): DiskQuotaDecision {
  const capability = classifyDiskQuota(info);

  if (mode === "none") {
    return {
      ...capability,
      mode,
      applied: false,
      enforced: false,
      detail:
        "PORKBOT_COMPUTER_DISK_QUOTA=none: the write layer is unbounded and belongs to the host's disk",
    };
  }

  if (mode === "storage-opt") {
    return {
      ...capability,
      mode,
      applied: true,
      enforced: capability.supported,
      detail: capability.supported
        ? `PORKBOT_COMPUTER_DISK_QUOTA=storage-opt: enforced (${capability.detail})`
        : `PORKBOT_COMPUTER_DISK_QUOTA=storage-opt: the create will carry the quota and ${capability.driver === "" ? "a daemon that named no driver" : `the "${capability.driver}" driver`} will refuse it because it does not answer it`,
    };
  }

  return {
    ...capability,
    mode,
    applied: capability.supported,
    enforced: capability.supported,
    detail: capability.supported
      ? `PORKBOT_COMPUTER_DISK_QUOTA=auto: enforced (${capability.detail})`
      : `PORKBOT_COMPUTER_DISK_QUOTA=auto: not enforced, because ${capability.detail}; raise the host or move the daemon to btrfs or overlay2 over xfs with pquota`,
  };
}

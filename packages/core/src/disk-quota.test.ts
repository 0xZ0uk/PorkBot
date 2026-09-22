import { describe, expect, it } from "vitest";
import {
  classifyDiskQuota,
  decideDiskQuota,
  DEFAULT_DISK_QUOTA_MODE,
  DISK_QUOTA_DRIVERS,
  DISK_QUOTA_MODES,
} from "./disk-quota.ts";

/**
 * The write-layer budget's register (slice 14.4). The classification decides
 * whether `PORKBOT_COMPUTER_DISK_MB` is a promise or a disclosed no-op, so the
 * cases below pin the answers a self-hoster's daemon can give.
 */
describe("disk quota classification", () => {
  it("answers supported for btrfs and overlay2 over xfs, and nothing else", () => {
    expect(classifyDiskQuota({ driver: "btrfs" }).supported).toBe(true);
    expect(classifyDiskQuota({ driver: "overlay2", backingFilesystem: "xfs" }).supported).toBe(
      true,
    );

    for (const info of [
      { driver: "overlay2" },
      { driver: "overlay2", backingFilesystem: "ext4" },
      { driver: "vfs" },
      { driver: "zfs" },
      { driver: "" },
    ]) {
      expect(classifyDiskQuota(info).supported, JSON.stringify(info)).toBe(false);
    }
  });

  it("names the driver and the reason in every refusal", () => {
    expect(classifyDiskQuota({ driver: "vfs" }).detail).toContain("vfs");
    expect(classifyDiskQuota({ driver: "overlay2", backingFilesystem: "ext4" }).detail).toContain(
      "overlay2",
    );
    expect(classifyDiskQuota({ driver: "" }).detail).toContain("no storage driver");
  });

  it("keeps the driver register short enough to review", () => {
    expect(DISK_QUOTA_MODES).toEqual(["auto", "none", "storage-opt"]);
    expect(DEFAULT_DISK_QUOTA_MODE).toBe("auto");
    expect(DISK_QUOTA_DRIVERS.map((entry) => entry.driver)).toEqual(["btrfs", "overlay2"]);
  });
});

describe("the disk quota decision", () => {
  it("auto enforces exactly where the driver answers", () => {
    const enforced = decideDiskQuota("auto", { driver: "btrfs" });

    expect(enforced.applied).toBe(true);
    expect(enforced.enforced).toBe(true);
    expect(enforced.detail).toContain("auto");

    const refused = decideDiskQuota("auto", { driver: "overlay2", backingFilesystem: "ext4" });

    // The budget is not sent to a driver that would ignore it, and the reason
    // is the shape an operator reads at boot.
    expect(refused.applied).toBe(false);
    expect(refused.enforced).toBe(false);
    expect(refused.detail).toContain("not enforced");
    expect(refused.detail).toContain("pquota");
  });

  it("none never applies the budget and says the write layer is unbounded", () => {
    const decision = decideDiskQuota("none", { driver: "btrfs" });

    expect(decision.applied).toBe(false);
    expect(decision.enforced).toBe(false);
    expect(decision.detail).toContain("none");
  });

  it("storage-opt always applies it, so an incapable driver refuses the create", () => {
    const capable = decideDiskQuota("storage-opt", {
      driver: "overlay2",
      backingFilesystem: "xfs",
    });

    expect(capable.applied).toBe(true);
    expect(capable.enforced).toBe(true);

    const incapable = decideDiskQuota("storage-opt", { driver: "vfs" });

    expect(incapable.applied).toBe(true);
    expect(incapable.enforced).toBe(false);
  });
});

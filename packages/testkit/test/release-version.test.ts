import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  compareReleaseVersions,
  isReleaseVersion,
  parseReleaseVersion,
  releaseTag,
} from "../src/release/version.ts";

describe("release versions", () => {
  it("reads exactly major.minor.patch, the shape the app's update check accepts", () => {
    expect(parseReleaseVersion("0.2.10")).toEqual([0, 2, 10]);
    expect(isReleaseVersion("1.0.0")).toBe(true);
    expect(isReleaseVersion("1.0")).toBe(false);
    expect(isReleaseVersion("1.0.0-rc.1")).toBe(false);
  });

  it("bumps each keyword and resets the digits below it", () => {
    expect(bumpVersion("0.2.3", "patch")).toEqual({ ok: true, version: "0.2.4" });
    expect(bumpVersion("0.2.3", "minor")).toEqual({ ok: true, version: "0.3.0" });
    expect(bumpVersion("0.2.3", "major")).toEqual({ ok: true, version: "1.0.0" });
  });

  it("accepts an explicit version only when it moves forward", () => {
    expect(bumpVersion("0.2.3", "0.4.0")).toEqual({ ok: true, version: "0.4.0" });

    for (const backwards of ["0.2.3", "0.2.2", "not-a-version"]) {
      expect(bumpVersion("0.2.3", backwards).ok).toBe(false);
    }
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareReleaseVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("0.9.9", "0.10.0")).toBeLessThan(0);
  });

  it("names the release tag in one place", () => {
    expect(releaseTag("0.4.0")).toBe("desktop-v0.4.0");
  });
});

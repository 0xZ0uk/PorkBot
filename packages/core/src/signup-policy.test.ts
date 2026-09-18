import { describe, expect, it } from "vitest";
import { decideSignup, isOwnerEmail, normalizeEmail } from "./signup-policy.ts";
import type { DeploymentSettings } from "./signup-policy.ts";

const configured: DeploymentSettings = {
  signupsEnabled: true,
  adminEmail: "operator@example.com",
};

describe("decideSignup on an unconfigured deployment", () => {
  it("is closed when there is no settings row at all", () => {
    expect(decideSignup("stranger@example.com")).toEqual({
      ok: false,
      reason: "signups_closed",
    });
    expect(decideSignup("stranger@example.com", undefined)).toEqual({
      ok: false,
      reason: "signups_closed",
    });
    expect(decideSignup("stranger@example.com", null)).toEqual({
      ok: false,
      reason: "signups_closed",
    });
  });

  it("is closed when signups were not explicitly enabled", () => {
    expect(
      decideSignup("stranger@example.com", { signupsEnabled: false, adminEmail: null }),
    ).toEqual({ ok: false, reason: "signups_closed" });
    expect(
      decideSignup("operator@example.com", {
        signupsEnabled: false,
        adminEmail: "operator@example.com",
      }),
    ).toEqual({ ok: false, reason: "signups_closed" });
  });

  it("fails closed when a settings value is missing at runtime", () => {
    expect(decideSignup("operator@example.com", {} as unknown as DeploymentSettings)).toEqual({
      ok: false,
      reason: "signups_closed",
    });
  });

  it("refuses the first registrant before any configuration exists", () => {
    for (const email of ["", " ", "first@example.com", "operator@example.com"]) {
      expect(decideSignup(email)).toEqual({ ok: false, reason: "signups_closed" });
    }
  });
});

describe("decideSignup owner assignment", () => {
  it("admits the configured admin email as owner", () => {
    expect(decideSignup("operator@example.com", configured)).toEqual({ ok: true, role: "owner" });
  });

  it("matches the admin email case-insensitively and ignores surrounding space", () => {
    expect(decideSignup("  Operator@Example.COM  ", configured)).toEqual({
      ok: true,
      role: "owner",
    });
    expect(
      decideSignup("operator@example.com", {
        signupsEnabled: true,
        adminEmail: "  Operator@Example.COM  ",
      }),
    ).toEqual({ ok: true, role: "owner" });
  });

  it("never assigns owner without an explicit admin email", () => {
    for (const adminEmail of [null, "", "   "]) {
      const settings: DeploymentSettings = { signupsEnabled: true, adminEmail };

      expect(decideSignup("stranger@example.com", settings)).toEqual({ ok: true, role: "member" });
    }

    expect(
      decideSignup("operator@example.com", {
        signupsEnabled: true,
      } as unknown as DeploymentSettings),
    ).toEqual({ ok: true, role: "member" });
  });

  it("refuses a blank or non-string address even with signups open", () => {
    for (const email of ["", "   ", 42, null, undefined]) {
      expect(decideSignup(email as unknown as string, configured)).toEqual({
        ok: false,
        reason: "invalid_email",
      });
    }
  });

  it("does not hand ownership to a lookalike address", () => {
    for (const email of [
      "operator@example.com.evil.test",
      "operator+admin@example.com",
      "operator@example.org",
      "operator@sub.example.com",
      "other@example.com",
    ]) {
      expect(decideSignup(email, configured)).toEqual({ ok: true, role: "member" });
    }
  });

  it("admits everyone else as a member once signups are explicitly open", () => {
    expect(decideSignup("stranger@example.com", configured)).toEqual({
      ok: true,
      role: "member",
    });
    expect(
      decideSignup("stranger@example.com", { signupsEnabled: true, adminEmail: null }),
    ).toEqual({ ok: true, role: "member" });
  });
});

describe("isOwnerEmail", () => {
  it("is true only for an explicit, matching admin email", () => {
    expect(isOwnerEmail("operator@example.com", "operator@example.com")).toBe(true);
    expect(isOwnerEmail("OPERATOR@example.com", "operator@example.com")).toBe(true);
    expect(isOwnerEmail("other@example.com", "operator@example.com")).toBe(false);
    expect(isOwnerEmail("operator@example.com", null)).toBe(false);
    expect(isOwnerEmail("operator@example.com", undefined)).toBe(false);
    expect(isOwnerEmail("operator@example.com", "   ")).toBe(false);
    expect(isOwnerEmail("   ", "   ")).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Operator@Example.COM ")).toBe("operator@example.com");
    expect(normalizeEmail("")).toBe("");
  });
});

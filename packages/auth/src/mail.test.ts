import { describe, expect, it } from "vitest";
import { passwordResetEmail, verificationEmail } from "./mail.ts";

describe("passwordResetEmail", () => {
  it("addresses the recipient and carries the reset link", () => {
    const message = passwordResetEmail(
      "operator@example.invalid",
      "https://bots.example.invalid/reset?token=abc",
    );

    expect(message.to).toBe("operator@example.invalid");
    expect(message.subject).toBe("Reset your PorkBot password");
    expect(message.text).toContain("https://bots.example.invalid/reset?token=abc");
    expect(message.text).toContain("one hour");
  });

  it("says what to do when the request was not the recipient's", () => {
    const message = passwordResetEmail(
      "operator@example.invalid",
      "https://bots.example.invalid/reset",
    );

    expect(message.text).toContain("If you did not ask");
  });
});

describe("verificationEmail", () => {
  it("addresses the recipient and carries the verification link", () => {
    const message = verificationEmail(
      "operator@example.invalid",
      "https://bots.example.invalid/verify?token=abc",
    );

    expect(message.to).toBe("operator@example.invalid");
    expect(message.subject).toBe("Verify your PorkBot email");
    expect(message.text).toContain("https://bots.example.invalid/verify?token=abc");
    expect(message.text).toContain("one hour");
  });
});

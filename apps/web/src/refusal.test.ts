import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./refusal.ts";
import { AuthRefusal } from "./session.ts";

describe("authErrorMessage", () => {
  it("keeps the server's sentence for a refusal", () => {
    expect(authErrorMessage(new AuthRefusal("refused", "Invalid email or password."))).toBe(
      "Invalid email or password.",
    );
  });

  it("owns the two cases the server cannot speak to", () => {
    expect(authErrorMessage(new AuthRefusal("unreachable", "anything"))).toContain(
      "Can’t reach the server",
    );
    expect(authErrorMessage(new AuthRefusal("not_signed_in", "anything"))).toContain(
      "did not complete",
    );
  });

  it("does not leak an unknown failure", () => {
    expect(authErrorMessage(new Error("connection reset by peer"))).toBe(
      "Something went wrong. Try again.",
    );
  });
});

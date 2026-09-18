import { describe, expect, it } from "vitest";
import { CredentialMissingError, NotFoundError } from "./errors.ts";

describe("the typed not-found error", () => {
  it("names the resource and the id the caller asked for", () => {
    const error = new NotFoundError("bot", "bot-1");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotFoundError");
    expect(error.resource).toBe("bot");
    expect(error.id).toBe("bot-1");
    expect(error.message).toBe("bot bot-1 was not found");
  });
});

describe("the typed credential-missing error", () => {
  it("names the credential without carrying a value", () => {
    const error = new CredentialMissingError("transactional-mail-api-key");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CredentialMissingError");
    expect(error.credentialName).toBe("transactional-mail-api-key");
    expect(error.message).toContain("transactional-mail-api-key");
    expect(error.message).toContain("not configured");
  });
});

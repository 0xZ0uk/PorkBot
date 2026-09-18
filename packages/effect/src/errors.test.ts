import { describe, expect, it } from "vitest";
import { NotFoundError } from "./errors.ts";

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

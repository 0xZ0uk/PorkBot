import { describe, expect, it } from "vitest";
import { quoteIdentifier } from "./queryable.ts";

describe("quoting a Postgres identifier", () => {
  it("wraps the name in double quotes", () => {
    expect(quoteIdentifier("bots")).toBe('"bots"');
  });

  it("doubles embedded quotes rather than letting them end the identifier", () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

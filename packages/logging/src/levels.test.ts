import { describe, expect, it } from "vitest";
import {
  defaultLogLevel,
  isLogLevel,
  levelEnabled,
  logLevelEnvVar,
  logLevels,
  parseLogLevel,
  resolveLogLevel,
} from "./index.ts";

describe("log levels", () => {
  it("defaults to info, the production-safe level", () => {
    expect(defaultLogLevel).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel({})).toBe("info");
  });

  it("accepts a configured level, ignoring case and surrounding whitespace", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel(" WARN ")).toBe("warn");
    expect(resolveLogLevel({ [logLevelEnvVar]: "error" })).toBe("error");
  });

  it("treats a blank level as unset", () => {
    expect(parseLogLevel("   ")).toBe("info");
  });

  it("refuses an unknown level instead of silently falling back", () => {
    expect(() => parseLogLevel("verbose")).toThrowError(/LOG_LEVEL/);
    expect(() => parseLogLevel("verbose")).toThrowError(/debug, info, warn, error/);
  });

  it("recognises exactly the declared levels", () => {
    for (const level of logLevels) {
      expect(isLogLevel(level)).toBe(true);
    }
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel(30)).toBe(false);
  });

  it("enables records at or above the threshold and drops the rest", () => {
    expect(levelEnabled("debug", "info")).toBe(false);
    expect(levelEnabled("info", "info")).toBe(true);
    expect(levelEnabled("warn", "info")).toBe(true);
    expect(levelEnabled("error", "info")).toBe(true);
    expect(levelEnabled("warn", "error")).toBe(false);
    expect(levelEnabled("error", "error")).toBe(true);
  });
});

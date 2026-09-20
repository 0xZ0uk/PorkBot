import type { PostgresDatabase } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { beforeEach, describe, expect, it } from "vitest";
import { operatorAuthFromEnvironment } from "./operator-auth.ts";

/**
 * The environment contract of the operator auth configuration. Everything the
 * configured path does beyond construction — the signup gate, the session
 * cookie, the membership — is exercised against a real Postgres in
 * `test/integration/operator-auth.integration.test.ts`; these cases pin the
 * boot decisions: absent means fail-closed, half-configured means no boot.
 */

const lines: string[] = [];
const logger = createLogger({
  service: "@porkbot/api",
  write: (line) => lines.push(line),
});

// Construction only wraps the handle in Better Auth's drizzle adapter; no
// statement runs until a request does, which this file never sends.
const database = {} as unknown as PostgresDatabase;

const secret = "operator-auth-test-secret-0123456789abcdef";
const origin = "http://localhost:5173";

function configure(env: Readonly<Record<string, string | undefined>>) {
  return operatorAuthFromEnvironment(env, { database, logger });
}

function warned(): boolean {
  return lines.some((line) => line.includes("operator auth is not configured"));
}

beforeEach(() => {
  lines.length = 0;
});

describe("an unconfigured process", () => {
  it("boots without auth and says so", () => {
    expect(configure({})).toBeNull();
    expect(warned()).toBe(true);
  });

  it("treats blank values as absent", () => {
    expect(configure({ PORKBOT_AUTH_SECRET: "  ", PORKBOT_AUTH_ORIGIN: "" })).toBeNull();
  });
});

describe("a half-configured process", () => {
  it("refuses a secret without an origin", () => {
    expect(() => configure({ PORKBOT_AUTH_SECRET: secret })).toThrow(/set together/);
  });

  it("refuses an origin without a secret", () => {
    expect(() => configure({ PORKBOT_AUTH_ORIGIN: origin })).toThrow(/set together/);
  });

  it("refuses an origin that is not an absolute URL", () => {
    expect(() =>
      configure({ PORKBOT_AUTH_SECRET: secret, PORKBOT_AUTH_ORIGIN: "localhost" }),
    ).toThrow(/absolute URL/);
  });

  it("refuses an origin with a non-http protocol", () => {
    expect(() =>
      configure({ PORKBOT_AUTH_SECRET: secret, PORKBOT_AUTH_ORIGIN: "ftp://example.invalid" }),
    ).toThrow(/http\(s\)/);
  });

  it("refuses a partial mail trio", () => {
    expect(() =>
      configure({
        PORKBOT_AUTH_SECRET: secret,
        PORKBOT_AUTH_ORIGIN: origin,
        PORKBOT_MAIL_ENDPOINT: "https://mail.example.invalid/send",
      }),
    ).toThrow(/set together/);
  });
});

describe("a configured process", () => {
  it("composes the auth handler and the session resolver", () => {
    const auth = configure({ PORKBOT_AUTH_SECRET: secret, PORKBOT_AUTH_ORIGIN: origin });

    expect(auth).not.toBeNull();
    expect(typeof auth?.handler).toBe("function");
    expect(typeof auth?.resolveActor).toBe("function");
  });

  it("carries a configured mail trio through", () => {
    const auth = configure({
      PORKBOT_AUTH_SECRET: secret,
      PORKBOT_AUTH_ORIGIN: origin,
      PORKBOT_MAIL_ENDPOINT: "https://mail.example.invalid/send",
      PORKBOT_MAIL_FROM: "porkbot@example.invalid",
      PORKBOT_MAIL_KEY: "mail-key-placeholder",
    });

    expect(auth).not.toBeNull();
  });

  it("warns when mail is not configured instead of refusing boot", () => {
    configure({ PORKBOT_AUTH_SECRET: secret, PORKBOT_AUTH_ORIGIN: origin });

    expect(lines.some((line) => line.includes("reset and verification mail will be refused"))).toBe(
      true,
    );
  });
});

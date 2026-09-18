import { describe, expect, it } from "vitest";
import {
  circularPlaceholder,
  isSensitiveFieldName,
  redact,
  redactPath,
  redactRecord,
  redactString,
  redactedPlaceholder,
  sensitiveFieldNames,
  truncatedPlaceholder,
  unredacted,
} from "./index.ts";

const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";

describe("sensitive field names", () => {
  it("treats key, token, secret and password as secrets by name", () => {
    for (const name of sensitiveFieldNames) {
      expect(isSensitiveFieldName(name)).toBe(true);
    }
  });

  it("matches compounds, separators, plurals, fused words and header casing", () => {
    for (const name of [
      "apiKey",
      "api_key",
      "apikey",
      "X-Api-Key",
      "accessToken",
      "access_token",
      "accesstoken",
      "clientSecret",
      "clientsecret",
      "dbPassword",
      "dbpassword",
      "jwtSecret",
      "passwords",
      "tokens",
      "keys",
      "secrets",
      "credentials",
      "authorization",
      "set-cookie",
    ]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
  });

  it("does not match words that merely end in a sensitive word", () => {
    for (const name of [
      "monkey",
      "turkey",
      "donkey",
      "tokenizer",
      "keyId",
      "secretSanta",
      "safe",
      "path",
    ]) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });
});

describe("redactRecord", () => {
  it("removes a known secret shape from sensitive fields, nested and in arrays", () => {
    const input = {
      token: secret,
      nested: { password: "hunter2" },
      list: [{ secret: "shhh" }],
      safe: "plain",
    };

    const output = redactRecord(input);
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("shhh");
    expect(output["token"]).toBe(redactedPlaceholder);
    expect(output["nested"]).toEqual({ password: redactedPlaceholder });
    expect(output["list"]).toEqual([{ secret: redactedPlaceholder }]);
    expect(output["safe"]).toBe("plain");
  });

  it("scrubs secret shapes hidden inside ordinary string values", () => {
    const output = redactRecord({ note: `failed with ${secret}`, authorization: secret });
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(secret);
    expect(output["note"]).toBe(`failed with ${redactedPlaceholder}`);
  });

  it("does not mutate the input", () => {
    const input = { token: secret, nested: { password: "hunter2" } };
    redactRecord(input);

    expect(input.token).toBe(secret);
    expect(input.nested.password).toBe("hunter2");
  });

  it("keeps a sensitive field only through the explicit unredacted opt-in", () => {
    const output = redactRecord({ token: unredacted(secret) });

    expect(output["token"]).toBe(secret);
  });

  it("keeps a whole unredacted subtree verbatim", () => {
    const output = redactRecord({
      credentials: unredacted({ token: secret, password: "hunter2" }),
    });

    expect(output["credentials"]).toEqual({ token: secret, password: "hunter2" });
  });

  it("replaces cycles and stops at the depth limit instead of throwing", () => {
    const node: Record<string, unknown> = { token: secret };
    node["self"] = node;

    const output = redactRecord(node);
    expect(output["self"]).toBe(circularPlaceholder);

    let deep: Record<string, unknown> = { token: secret };
    for (let index = 0; index < 12; index += 1) {
      deep = { child: deep };
    }

    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(redact(deep))).toContain(truncatedPlaceholder);
  });
});

describe("redact", () => {
  it("converts errors to redacted plain objects", () => {
    const cause = new Error(`root cause ${secret}`);
    const error = new Error("upstream said token=abc123", { cause });
    error.stack = `Error: upstream said token=abc123\n    at handler (/srv/app.ts:1:1)`;
    Object.assign(error, { code: "EUPSTREAM", token: "hunter2" });

    const output = redact(error) as Record<string, unknown>;
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("hunter2");
    expect(output["name"]).toBe("Error");
    expect(output["message"]).toBe(`upstream said token=${redactedPlaceholder}`);
    expect(output["cause"]).toMatchObject({ message: `root cause ${redactedPlaceholder}` });
    expect(output["code"]).toBe("EUPSTREAM");
    expect(output["token"]).toBe(redactedPlaceholder);
  });

  it("unwraps an unredacted value without redacting it", () => {
    expect(redact(unredacted(secret))).toBe(secret);
    expect(redact({ note: unredacted(secret) })).toEqual({ note: secret });
  });
});

describe("redactString", () => {
  it("removes the credential from authorization schemes", () => {
    expect(redactString("send Bearer abcdefghijklmnop now")).toBe(
      `send Bearer ${redactedPlaceholder} now`,
    );
    expect(redactString("Basic dXNlcjpwYXNzd29yZA==")).toBe(`Basic ${redactedPlaceholder}`);
    expect(redactString("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: ${redactedPlaceholder}`,
    );
  });

  it("removes vendor key shapes", () => {
    for (const value of [
      secret,
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-abcdefghijklmnop",
    ]) {
      const output = redactString(`key is ${value} ok`);
      expect(output, value).not.toContain(value);
      expect(output, value).toContain(redactedPlaceholder);
    }
  });

  it("removes JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactString(`bearer ${jwt}`)).not.toContain(jwt);
  });

  it("removes credentials from connection strings but keeps the host", () => {
    expect(redactString("postgres://porkbot:hunter2@127.0.0.1:5432/porkbot")).toBe(
      `postgres://${redactedPlaceholder}@127.0.0.1:5432/porkbot`,
    );
    expect(redactString("redis://:hunter2@cache:6379")).toBe(
      `redis://${redactedPlaceholder}@cache:6379`,
    );
  });

  it("removes PEM private keys", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAyQ==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactString(pem)).toBe(redactedPlaceholder);
  });

  it("removes values assigned to sensitive names inside free text", () => {
    expect(redactString("connecting with password=hunter2 now")).toBe(
      `connecting with password=${redactedPlaceholder} now`,
    );
    expect(redactString('config {"api_key": "abc123"}')).toBe(
      `config {"api_key": ${redactedPlaceholder}}`,
    );
  });

  it("removes compound assignment names, in both snake and camel case", () => {
    for (const assignment of [
      "access_token=abc123",
      "refreshToken=abc123",
      "client_secret=abc123",
      "apiKey=abc123",
      "apikey=abc123",
      "dbPassword=abc123",
      "dbpassword=abc123",
      "aws_secret_access_key=abc123",
      "mySecret=abc123",
      'id_token="abc123"',
    ]) {
      const output = redactString(`redirect ${assignment}`);
      expect(output, assignment).not.toContain("abc123");
      expect(output, assignment).toContain(redactedPlaceholder);
    }
  });

  it("leaves ordinary words that end in a sensitive word alone", () => {
    expect(redactString("monkey=banana")).toBe("monkey=banana");
  });

  it("finds a sensitive assignment nested behind an ordinary name: value pair", () => {
    expect(redactString("failed to refresh: token=abc123 expired")).toBe(
      `failed to refresh: token=${redactedPlaceholder} expired`,
    );
    expect(redactString('config {"outer": {"token": "abc123"}}')).toBe(
      `config {"outer": {"token": ${redactedPlaceholder}}}`,
    );
    expect(redactString("url https://example.com/cb?access_token=abc123")).toBe(
      `url https://example.com/cb?access_token=${redactedPlaceholder}`,
    );
  });
});

describe("redact JSON safety", () => {
  it("converts the values JSON cannot represent", () => {
    const output = redact({
      when: new Date("2026-09-18T10:00:00.000Z"),
      link: new URL("https://example.com/cb?access_token=abc123"),
      big: 10n,
      missing: undefined,
      action: () => undefined,
      token: secret,
    }) as Record<string, unknown>;

    expect(output["when"]).toBe("2026-09-18T10:00:00.000Z");
    expect(output["link"]).toBe("https://example.com/cb?access_token=[redacted]");
    expect(output["big"]).toBe("10");
    expect(output["missing"]).toBeUndefined();
    expect(output["action"]).toBeUndefined();
    expect(output["token"]).toBe(redactedPlaceholder);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("converts maps and sets without leaking their values", () => {
    const output = redactRecord({
      map: new Map([
        ["token", secret],
        ["password", "hunter2"],
      ]),
      set: new Set([secret]),
    });

    expect(output["map"]).toEqual({ token: redactedPlaceholder, password: redactedPlaceholder });
    expect(output["set"]).toEqual([redactedPlaceholder]);
  });

  it("keeps a map entry only through the explicit unredacted opt-in", () => {
    const output = redactRecord({ map: new Map([["token", unredacted(secret)]]) });

    expect(output["map"]).toEqual({ token: secret });
  });
});

describe("redactPath", () => {
  it("removes values of sensitive query parameters", () => {
    const output = redactPath("/oauth/callback?access_token=abc123&state=xyz");

    expect(output).not.toContain("abc123");
    expect(output).toBe(`/oauth/callback?access_token=${redactedPlaceholder}&state=xyz`);
  });

  it("still shape-scrubs the rest of the path", () => {
    const output = redactPath(`/search?q=${secret}`);

    expect(output).not.toContain(secret);
    expect(output.startsWith("/search?q=")).toBe(true);
  });

  it("leaves an ordinary path alone", () => {
    expect(redactPath("/healthz")).toBe("/healthz");
  });

  it("matches escaped parameter names and keeps untouched pairs as written", () => {
    expect(redactPath("/cb?%61ccess_token=abc123&state=a+b&empty=")).toBe(
      `/cb?%61ccess_token=${redactedPlaceholder}&state=a+b&empty=`,
    );
  });

  it("redacts a bare sensitive parameter without a value", () => {
    expect(redactPath("/cb?password")).toBe(`/cb?${redactedPlaceholder}`);
  });

  it("redacts fused parameter names", () => {
    expect(redactPath("/cb?apikey=abc123&next=1")).toBe(`/cb?apikey=${redactedPlaceholder}&next=1`);
  });
});

describe("the logged string length bound", () => {
  it("replaces an oversized string whole instead of scanning it", () => {
    const started = Date.now();
    const output = redactString("A".repeat(2 * 1024 * 1024));

    expect(output).toBe(truncatedPlaceholder);
    // Before the bound, the assignment scanner was quadratic on a long
    // separator-free token: this call ran for minutes. The budget is loose
    // enough for a loaded CI machine and still fails loudly on a regression.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps a large caller-supplied validation input out of the redacted error", () => {
    const error = new Error("Input validation failed", {
      cause: { data: "A".repeat(2 * 1024 * 1024) },
    });
    const started = Date.now();
    const serialized = JSON.stringify(redact({ error }));

    expect(serialized).toContain(truncatedPlaceholder);
    expect(serialized).not.toContain("A".repeat(64));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

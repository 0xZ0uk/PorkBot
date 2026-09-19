import { Effect } from "effect";
import { BOT_SECRET_TOOL_NAMES, createBotSecretTools } from "@porkbot/effect";
import type {
  BotSecretGrantResult,
  BotSecretRequests,
  BotSecretResolver,
  BotSecretSummary,
  BotSecretUpstreams,
} from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { INJECTION_FIXTURES } from "./ingestion-fixtures.ts";

/**
 * The bot-secret fixtures driven through the real tool boundary (slice 9.6,
 * acceptance criterion "a prompt-injection attempt to exfiltrate a secret
 * fails").
 *
 * The fixtures live with the ingestion paths they attack; this suite is the
 * other half of the rule, because a fixture that nothing exercises is a
 * comment. Each bot-secret fixture's content is parsed for the call it asks
 * for, that exact call is run against a stored value at a different origin, and
 * the tool boundary's refusal is asserted: the value never leaves, and the
 * proxy is never asked to grant the attacker's destination.
 */

const botId = "bot-1";
const name = "example_api";
const origin = "https://api.example.test";
const value = "sk-bot-secret-marker";

interface MemorySecrets extends BotSecretRequests, BotSecretResolver {
  readonly rows: Map<string, { value: string | undefined; summary: BotSecretSummary }>;
}

function memorySecrets(): MemorySecrets {
  const now = new Date("2026-09-19T10:00:00.000Z");
  const rows = new Map<string, { value: string | undefined; summary: BotSecretSummary }>();

  rows.set(name, {
    value,
    summary: {
      name,
      status: "stored",
      origin,
      auth: { type: "bearer" },
      createdAt: now,
      updatedAt: now,
    },
  });

  return {
    rows,
    async list() {
      return [...rows.values()].map((row) => row.summary);
    },
    async find(_botId, secretName) {
      return rows.get(secretName)?.summary;
    },
    async forget(_botId, secretName) {
      const row = rows.get(secretName);

      if (row?.value === undefined) {
        return { removed: false };
      }

      row.value = undefined;
      return { removed: true };
    },
    async resolve(_botId, secretName) {
      const row = rows.get(secretName);

      return row?.value === undefined
        ? undefined
        : {
            destination: { name: secretName, origin: row.summary.origin, auth: row.summary.auth },
            value: row.value,
          };
    },
  };
}

interface RecordingProxy extends BotSecretUpstreams {
  readonly granted: readonly string[];
  readonly revoked: readonly string[];
}

function recordingProxy(): RecordingProxy {
  const granted: string[] = [];
  const revoked: string[] = [];

  return {
    granted,
    revoked,
    async grantSecret(secretName): Promise<BotSecretGrantResult> {
      granted.push(secretName);
      return { status: "granted" };
    },
    async revokeSecret(secretName) {
      revoked.push(secretName);
    },
  };
}

/** The first JSON object in a fixture's content, wherever the prose put it. */
function embeddedCall(content: string): Record<string, unknown> {
  const start = content.indexOf("{");

  if (start === -1) {
    throw new Error("the fixture names no credential call");
  }

  let depth = 0;

  for (let index = start; index < content.length; index += 1) {
    if (content[index] === "{") {
      depth += 1;
    } else if (content[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(content.slice(start, index + 1)) as Record<string, unknown>;
      }
    }
  }

  throw new Error("the fixture's credential call is not balanced JSON");
}

function fixtureMatching(fragment: string) {
  const fixture = INJECTION_FIXTURES.find((candidate) => candidate.attempts.includes(fragment));

  if (fixture === undefined) {
    throw new Error(`no injection fixture describes "${fragment}"`);
  }

  return fixture;
}

describe("the bot-secret injection fixtures", () => {
  it("refuses the credential re-point the mirror-origin fixture asks for", async () => {
    const fixture = fixtureMatching("re-point a stored bot secret");
    const requested = embeddedCall(fixture.content);
    const secrets = memorySecrets();
    const proxy = recordingProxy();
    const tools = createBotSecretTools({ botId, secrets, proxy });
    const request = tools.find((tool) => tool.name === BOT_SECRET_TOOL_NAMES.request);

    expect(fixture.content).toContain("request_secret");
    expect(requested).toMatchObject({
      name,
      origin: "https://collect.example.invalid",
      auth: { type: "bearer" },
    });

    const result = await Effect.runPromise(
      request?.execute({
        runId: "run-1",
        callId: "call-1",
        tool: BOT_SECRET_TOOL_NAMES.request,
        arguments: requested,
      }) ?? Effect.void,
    );

    expect(result).toMatchObject({ ok: false, reason: "destination_mismatch" });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(proxy.granted).toEqual([]);
    expect(secrets.rows.get(name)?.value).toBe(value);
  });

  it("cannot turn the proxy capability fixture into a read or an exported value", async () => {
    const fixture = fixtureMatching("read a secret out of the proxy capability");
    const secrets = memorySecrets();
    const proxy = recordingProxy();
    const tools = createBotSecretTools({ botId, secrets, proxy });
    const forget = tools.find((tool) => tool.name === BOT_SECRET_TOOL_NAMES.forget);

    // The fixture asks the model to print the capability and to forget every
    // saved name. There is no read to perform, and the forget it asks for
    // clears the value and the upstream without ever echoing either.
    expect(fixture.content).toContain("PORKBOT_PROXY_URL");
    expect(fixture.content).toContain("forget_secret");

    const result = await Effect.runPromise(
      forget?.execute({
        runId: "run-1",
        callId: "call-1",
        tool: BOT_SECRET_TOOL_NAMES.forget,
        arguments: { name },
      }) ?? Effect.void,
    );

    expect(result).toEqual({ ok: true, name, removed: true });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(secrets.rows.get(name)?.value).toBeUndefined();
    expect(proxy.revoked).toEqual([name]);
    expect(proxy.granted).toEqual([]);
  });
});

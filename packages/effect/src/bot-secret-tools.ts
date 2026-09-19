import { Effect } from "effect";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  isBotSecretName,
  MAX_BOT_SECRET_NAME_LENGTH,
  parseBotSecretDestination,
  sameBotSecretDestination,
} from "@porkbot/core";
import type { ApprovalStore } from "./approval-gate.ts";
import type { BotSecretRequests } from "./bot-secrets.ts";
import { actionRefusalResult, createDangerousActionGuard } from "./danger-guard.ts";
import type { ToolCall, ToolRegistration } from "./tool-dispatcher.ts";
import type { BotSecretUpstreams } from "./run-credential-proxy.ts";

/**
 * The bot-secret tools (slice 9.6, E9 epic; reference parity `request_secret`,
 * `list_secrets` and `forget_secret`).
 *
 * An agent cannot read a secret, and it is offered no tool that could. What it
 * can do is ask: `request_secret` names a credential and the one HTTPS origin
 * it is for, and the ask becomes the run's durable approval gate (slice 10.2's
 * `credential_request` class) — the operator sees the destination, not a
 * prompt. On approval the run's credential proxy grows one upstream by that
 * name: the value is resolved server-side and injected into the request header
 * there, so the only way to use the secret is through `$PORKBOT_PROXY_URL`, and
 * the value never reaches the model's context, a tool result, the timeline or
 * the sandbox's environment.
 *
 * `list_secrets` answers names and status only. `forget_secret` clears the
 * stored value and takes the upstream back in the same call, so the next
 * request naming it is refused; the durable tool-call ledger records the
 * forget, and no tool exposes a value. The forget is deliberately ungated —
 * it removes an access rather than exercising one, and waiting for an operator
 * would make it neither immediate nor the emergency stop it is meant to be.
 * `request_secret` re-reads the stored destination after the approval resolves
 * and refuses a value that no longer matches what the operator approved, so a
 * write made while the gate was open can never redirect the grant.
 *
 * A destination that disagrees with a stored value is refused rather than
 * re-pointed: the value is bound to the origin the operator stored it for, so
 * an injected instruction cannot ask for a stored credential at an attacker's
 * origin. Every store failure keeps the shared vocabulary; nothing here logs,
 * stores or echoes a candidate value.
 */

/** The names the model sees; nothing restates these strings. */
export const BOT_SECRET_TOOL_NAMES = {
  request: "request_secret",
  list: "list_secrets",
  forget: "forget_secret",
} as const;

/** The default budget for the store and proxy work after an approval resolves. */
export const DEFAULT_BOT_SECRET_TOOL_DURATION_MS = 30_000;
/** The longest name the tool will carry, matching the store's own bound. */
export const MAX_SECRET_TOOL_NAME_LENGTH = MAX_BOT_SECRET_NAME_LENGTH;

export interface BotSecretToolOptions {
  /** The run's bot. Fixed here, never read from a tool argument. */
  readonly botId: string;
  /**
   * The run's half of the bot-secret rows: metadata reads and the forget. It
   * has no method that returns a value, so "the model never reads a secret" is
   * a property of this option's type.
   */
  readonly secrets: BotSecretRequests;
  /**
   * The run's proxy handle half: resolve a secret into one more upstream, or
   * take one back. The value is resolved inside the handle; nothing on this
   * interface returns it.
   */
  readonly proxy: BotSecretUpstreams;
  /**
   * The run's durable approval store. `request_secret` is always gated; with no
   * store the call is refused rather than answered. `maxDurationMs` must cover
   * the approval window when this is set.
   */
  readonly approvals?: ApprovalStore | undefined;
  /** How long an unanswered ask waits before it denies; defaults to the gate's own. */
  readonly approvalTimeoutMs?: number | undefined;
  /** How often a waiting ask re-reads the approval row; defaults to the gate's own. */
  readonly approvalPollIntervalMs?: number | undefined;
  /** The tools' declared budget; defaults to the approval window plus the work budget. */
  readonly maxDurationMs?: number | undefined;
}

const authSchema = {
  description: "How the value authenticates to its one origin.",
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "bearer", type: "string" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "header", type: "string" },
        name: { type: "string", description: "The request header the value rides in." },
      },
      required: ["type", "name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "basic", type: "string" },
        username: { type: "string", description: "The username; the value is the password." },
      },
      required: ["type", "username"],
      additionalProperties: false,
    },
  ],
} as const;

const requestParameters = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        `A lowercase identifier for the credential, at most ${MAX_SECRET_TOOL_NAME_LENGTH} ` +
        'characters (for example "example_api").',
    },
    origin: {
      type: "string",
      description:
        "The one HTTPS origin the credential may be sent to, with no path, query or " +
        'credentials (for example "https://api.example.test").',
    },
    auth: authSchema,
  },
  required: ["name", "origin", "auth"],
  additionalProperties: false,
} as const;

const listParameters = { type: "object", properties: {}, additionalProperties: false } as const;

const forgetParameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "The credential name to forget." },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const rejections: Record<string, string> = {
  invalid_name: "name must be a lowercase identifier of letters, digits and underscores",
  invalid_origin: "origin must be a bare HTTPS origin with no path, query or credentials",
  invalid_auth: "auth must be bearer, a usable header name, or basic with a username",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createBotSecretTools(options: BotSecretToolOptions): readonly ToolRegistration[] {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const maxDurationMs =
    options.maxDurationMs ??
    (options.approvals === undefined
      ? DEFAULT_BOT_SECRET_TOOL_DURATION_MS
      : approvalTimeoutMs + DEFAULT_BOT_SECRET_TOOL_DURATION_MS);

  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new RangeError(`maxDurationMs must be a positive integer, received ${maxDurationMs}`);
  }

  // A gate cannot outlive the tool's declared budget: the dispatcher would time
  // the call out while it was still waiting, and the model would read
  // `timed_out` instead of the operator's answer.
  if (options.approvals !== undefined && maxDurationMs <= approvalTimeoutMs) {
    throw new RangeError(
      `maxDurationMs ${maxDurationMs} does not cover the ${approvalTimeoutMs}ms approval window; ` +
        "a gated ask would time out before an operator could answer",
    );
  }

  const guard = createDangerousActionGuard({
    ...(options.approvals === undefined ? {} : { store: options.approvals }),
    ...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
    ...(options.approvalPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.approvalPollIntervalMs }),
  });

  const store = <A>(work: () => Promise<A>): Effect.Effect<A, unknown> =>
    Effect.tryPromise({ try: work, catch: (error) => error });

  const request: ToolRegistration = {
    name: BOT_SECRET_TOOL_NAMES.request,
    description:
      "Ask the operator to let this run use a saved API credential. Naming a credential and " +
      "its one HTTPS origin opens an approval request; once approved, the credential is " +
      "reachable only through this run's proxy at $PORKBOT_PROXY_URL/u/<name>, which injects " +
      "it. The value is never returned to you and never put in a command or a prompt.",
    parameters: requestParameters,
    maxDurationMs,
    execute: (call: ToolCall) =>
      Effect.gen(function* () {
        const parsed = parseBotSecretDestination(call.arguments);

        if (!parsed.ok) {
          return {
            ok: false,
            reason: "invalid_arguments",
            message: rejections[parsed.reason] ?? "the credential destination is not usable",
          };
        }

        const destination = parsed.value;
        const existing = yield* store(() => options.secrets.find(options.botId, destination.name));

        if (
          existing !== undefined &&
          existing.status === "stored" &&
          !sameBotSecretDestination(existing, destination)
        ) {
          return {
            ok: false,
            reason: "destination_mismatch",
            message:
              `a credential named "${destination.name}" is already stored for another ` +
              "destination; the operator must forget it before a new destination can be used",
          };
        }

        const authorization = yield* guard.authorize({ call, declared: ["credential_request"] });

        if (authorization.status === "refused" || authorization.status === "denied") {
          return actionRefusalResult(authorization);
        }

        // The approval is bound to the destination the operator saw, and the
        // store can have changed while the gate was open (a value stored, a
        // value forgotten, a destination the operator typed differently). The
        // re-read is what keeps the egress and the approved record in
        // agreement: a value that no longer matches is never granted.
        const stored = yield* store(() => options.secrets.find(options.botId, destination.name));

        if (stored === undefined || stored.status !== "stored") {
          return {
            ok: false,
            reason: "credential_missing",
            name: destination.name,
            message:
              "the operator approved, but no value is stored for this credential yet; report " +
              "that it still needs to be saved before the request can be made",
          };
        }

        if (!sameBotSecretDestination(stored, destination)) {
          return {
            ok: false,
            reason: "destination_mismatch",
            message:
              `the stored credential "${destination.name}" does not match the destination ` +
              "this ask was approved for; the operator must forget it and store a value for " +
              "the requested origin",
          };
        }

        const granted = yield* store(() => options.proxy.grantSecret(destination.name));

        if (granted.status === "granted") {
          return {
            ok: true,
            name: destination.name,
            status: "granted",
            message:
              `the credential is available through this run's proxy at /u/${destination.name}; ` +
              "send requests to $PORKBOT_PROXY_URL/u/" +
              `${destination.name}/... and the proxy adds the authentication`,
          };
        }

        if (granted.status === "missing") {
          return {
            ok: false,
            reason: "credential_missing",
            name: destination.name,
            message:
              "the operator approved, but no value is stored for this credential yet; report " +
              "that it still needs to be saved before the request can be made",
          };
        }

        if (granted.status === "name_taken") {
          return {
            ok: false,
            reason: "name_taken",
            name: destination.name,
            message: `the name "${destination.name}" already belongs to another upstream on this run`,
          };
        }

        return {
          ok: false,
          reason: "proxy_unavailable",
          name: destination.name,
          message: "this run has no credential proxy, so the credential cannot be used",
        };
      }),
  };

  const list: ToolRegistration = {
    name: BOT_SECRET_TOOL_NAMES.list,
    description:
      "List the saved credential names for this bot and whether each has a stored value. " +
      "Values are never returned and there is no tool that can read one.",
    parameters: listParameters,
    maxDurationMs,
    execute: () =>
      Effect.gen(function* () {
        const rows = yield* store(() => options.secrets.list(options.botId));

        return {
          ok: true,
          secrets: rows.map((row) => ({ name: row.name, status: row.status })),
        };
      }),
  };

  const forget: ToolRegistration = {
    name: BOT_SECRET_TOOL_NAMES.forget,
    description:
      "Forget a saved credential for this bot: the stored value is cleared and this run's " +
      "proxy stops carrying it immediately, so later requests naming it are refused. A name " +
      "no credential holds is a no-op.",
    parameters: forgetParameters,
    maxDurationMs,
    execute: (call: ToolCall) =>
      Effect.gen(function* () {
        const record = asRecord(call.arguments);
        const name = record?.["name"];

        if (!isBotSecretName(name)) {
          return {
            ok: false,
            reason: "invalid_arguments",
            message: "name must be a lowercase identifier of letters, digits and underscores",
          };
        }

        const result = yield* store(() => options.secrets.forget(options.botId, name));

        yield* store(() => options.proxy.revokeSecret(name));

        return { ok: true, name, removed: result.removed };
      }),
  };

  return [request, list, forget];
}

import { Effect } from "effect";
import { createHash } from "node:crypto";
import type { MemoryKind, MemoryWriteDecision, RecallLimits } from "@porkbot/core";
import {
  assertRecallLimits,
  boundRecallMatches,
  DEFAULT_RECALL_LIMITS,
  isMemoryKind,
} from "@porkbot/core";
import type { MemoryProvider } from "@porkbot/adapter-kit";
import type { MemoryProposals } from "./memory-store.ts";
import type { ToolCall, ToolRegistration } from "./tool-dispatcher.ts";

/**
 * The agent's memory tools (slice 8.2, PRD decision 21; stories 23 and 24).
 *
 * A run reaches the memory lane through three registrations, and the store
 * behind them is the one that decides: `remember` proposes a create or a
 * rewrite through `MemoryProposals`, `recall` searches the provider index
 * within `RecallLimits`, and `forget` asks for a deletion the rules refuse to
 * an agent. Nothing here writes a row or deletes one; the actor split in
 * `@porkbot/db` binds the origin to `agent_proposed` and the author to the bot,
 * so a rewrite is recorded as a revision the operator can read and a deletion
 * is an operator act. A refusal is an outcome the model reads, not a thrown
 * error: the model should learn why the write did not happen and choose
 * another path, and the call itself is durable and visible in the timeline.
 *
 * The document id of a create is derived from the run and the call id, so the
 * same replayed call proposes the same id and cannot grow a second document;
 * a rewrite the model intends names an id it recalled.
 *
 * Recall is bounded here as well as at the event layer: the search is asked
 * for at most `maxMatches` and every answer is clipped to the limits, with the
 * dropped count reported, so a recall never floods a prompt.
 */

/** The names the model sees; nothing restates these strings. */
export const MEMORY_TOOL_NAMES = {
  remember: "remember",
  recall: "recall",
  forget: "forget",
} as const;

export interface MemoryToolOptions {
  /** The bot whose memory these tools reach; fixed per run, never from arguments. */
  readonly botId: string;
  /** The run's half of the store: proposals only, so origin and author are bound. */
  readonly proposals: MemoryProposals;
  /** The index recall runs against; recall degrades to its lexical floor by composition. */
  readonly recall: MemoryProvider;
  /** Defaults to `DEFAULT_RECALL_LIMITS`; every search is clamped to them. */
  readonly limits?: RecallLimits | undefined;
  /**
   * The tool's declared budget and its claim on the run lease. Defaults to
   * 10 seconds; memory work is a query and a local write, never a browser.
   */
  readonly maxDurationMs?: number | undefined;
}

const defaultMaxDurationMs = 10_000;

const rememberParameters = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["fact", "preference", "decision"],
      description: "Required when creating a document. A document keeps its kind when rewritten.",
    },
    title: { type: "string", description: "A short title the operator scans." },
    content: { type: "string", description: "The durable fact or preference itself." },
    reason: {
      type: "string",
      description: "Why this should be remembered; recorded on the revision.",
    },
    document_id: {
      type: "string",
      description:
        "Rewrite an existing document by the id a recall returned. Omit to create a new document.",
    },
  },
  required: ["title", "content", "reason"],
  additionalProperties: false,
} as const;

const recallParameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search the bot's memory for." },
    limit: {
      type: "integer",
      minimum: 1,
      description: "Most matches to return; the run's recall limits clamp it.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const forgetParameters = {
  type: "object",
  properties: {
    document_id: {
      type: "string",
      description: "The document to remove, as a recall returned it.",
    },
    reason: { type: "string", description: "Why it should be removed; shown to the operator." },
  },
  required: ["document_id", "reason"],
  additionalProperties: false,
} as const;

/**
 * A create names its kind; a rewrite may omit it because a document keeps the
 * kind it was created with. A rewrite that does name a kind is accepted and the
 * resulting revision reports the stored kind, so the model sees what it got
 * rather than a write it cannot reconcile.
 */
type RememberArguments =
  | {
      readonly action: "create";
      readonly kind: MemoryKind;
      readonly title: string;
      readonly content: string;
      readonly reason: string;
    }
  | {
      readonly action: "update";
      readonly kind: MemoryKind | undefined;
      readonly title: string;
      readonly content: string;
      readonly reason: string;
      readonly documentId: string;
    };

interface RecallArguments {
  readonly query: string;
  readonly limit: number;
}

interface ForgetArguments {
  readonly documentId: string;
  readonly reason: string;
}

type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function invalid(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

function parseRemember(value: unknown): ParseResult<RememberArguments> {
  const record = asRecord(value);

  if (record === undefined) {
    return invalid("arguments must be an object");
  }

  const rawKind = record["kind"];

  if (rawKind !== undefined && !isMemoryKind(rawKind)) {
    return invalid("kind must be one of fact, preference or decision");
  }

  const kind = rawKind === undefined ? undefined : rawKind;

  const title = readText(record, "title");
  const content = readText(record, "content");
  const reason = readText(record, "reason");

  if (title === undefined) {
    return invalid("title must be a non-blank string");
  }

  if (content === undefined) {
    return invalid("content must be a non-blank string");
  }

  if (reason === undefined) {
    return invalid("reason must be a non-blank string");
  }

  const rawDocumentId = record["document_id"];

  if (rawDocumentId !== undefined && typeof rawDocumentId !== "string") {
    return invalid("document_id must be a string when present");
  }

  const documentId = rawDocumentId === undefined ? undefined : rawDocumentId.trim();

  if (documentId === "") {
    return invalid("document_id must be non-blank when present; omit it to create");
  }

  if (documentId === undefined) {
    return kind === undefined
      ? invalid("kind is required when creating a document")
      : { ok: true, value: { action: "create", kind, title, content, reason } };
  }

  return { ok: true, value: { action: "update", kind, title, content, reason, documentId } };
}

function parseRecall(value: unknown, limits: RecallLimits): ParseResult<RecallArguments> {
  const record = asRecord(value);

  if (record === undefined) {
    return invalid("arguments must be an object");
  }

  const query = readText(record, "query");
  if (query === undefined) {
    return invalid("query must be a non-blank string");
  }

  const rawLimit = record["limit"];

  if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit))) {
    return invalid("limit must be an integer when present");
  }

  if (rawLimit !== undefined && rawLimit < 1) {
    return invalid("limit must be at least 1 when present");
  }

  return {
    ok: true,
    value: { query, limit: Math.min(rawLimit ?? limits.maxMatches, limits.maxMatches) },
  };
}

function parseForget(value: unknown): ParseResult<ForgetArguments> {
  const record = asRecord(value);

  if (record === undefined) {
    return invalid("arguments must be an object");
  }

  const documentId = readText(record, "document_id");
  const reason = readText(record, "reason");

  if (documentId === undefined) {
    return invalid("document_id must be a non-blank string");
  }

  if (reason === undefined) {
    return invalid("reason must be a non-blank string");
  }

  return { ok: true, value: { documentId, reason } };
}

/** The id a create writes to: stable across a replay of the same call. */
function mintedDocumentId(call: ToolCall): string {
  const digest = createHash("sha256").update(`${call.runId}\u0000${call.callId}`).digest("hex");

  return `memory-${digest.slice(0, 32)}`;
}

/**
 * What a decision means to the model. A refusal keeps the rule's own name and
 * message: "agent writes cannot delete memory" is the recovery hint, and the
 * rule's text carries no secret. `no_change` is a success with nothing written.
 */
function decisionResult(decision: MemoryWriteDecision, documentId: string): unknown {
  if (decision.ok) {
    return decision.action === "no_change"
      ? { ok: true, action: "no_change", documentId }
      : {
          ok: true,
          action: decision.action,
          documentId: decision.revision.documentId,
          revision: decision.revision.revision,
          kind: decision.revision.kind,
        };
  }

  return {
    ok: false,
    documentId,
    reason: decision.error.name,
    message: decision.error.message,
  };
}

export function createMemoryTools(options: MemoryToolOptions): readonly ToolRegistration[] {
  const limits = options.limits ?? DEFAULT_RECALL_LIMITS;
  const maxDurationMs = options.maxDurationMs ?? defaultMaxDurationMs;

  assertRecallLimits(limits);

  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new RangeError(`maxDurationMs must be a positive integer, received ${maxDurationMs}`);
  }

  const remember: ToolRegistration = {
    name: MEMORY_TOOL_NAMES.remember,
    description:
      "Remember something durable for this bot: a fact, a preference or a decision. " +
      "Every write is recorded as a revision the operator can see. Pass document_id to rewrite " +
      "a document you recalled; omit it to create a new one.",
    parameters: rememberParameters,
    maxDurationMs,
    execute: (call) =>
      Effect.gen(function* () {
        const parsed = parseRemember(call.arguments);

        if (!parsed.ok) {
          return { ok: false, reason: "invalid_arguments", message: parsed.message };
        }

        const parsedWrite = parsed.value;
        const targetId =
          parsedWrite.action === "create" ? mintedDocumentId(call) : parsedWrite.documentId;

        const decision = yield* Effect.tryPromise({
          try: () =>
            options.proposals.propose(options.botId, {
              write:
                parsedWrite.action === "create"
                  ? {
                      action: "create",
                      documentId: targetId,
                      kind: parsedWrite.kind,
                      title: parsedWrite.title,
                      content: parsedWrite.content,
                    }
                  : {
                      action: "update",
                      documentId: targetId,
                      title: parsedWrite.title,
                      content: parsedWrite.content,
                    },
              reason: parsedWrite.reason,
            }),
          catch: (error) => error,
        });

        return decisionResult(decision, targetId);
      }),
  };

  const recall: ToolRegistration = {
    name: MEMORY_TOOL_NAMES.recall,
    description:
      "Search this bot's durable memory for a query. Returns bounded matches with document ids " +
      "you can pass to remember (to rewrite) or forget (to ask for removal).",
    parameters: recallParameters,
    maxDurationMs,
    execute: (call) =>
      Effect.gen(function* () {
        const parsed = parseRecall(call.arguments, limits);

        if (!parsed.ok) {
          return { ok: false, reason: "invalid_arguments", message: parsed.message };
        }

        const matches = yield* Effect.tryPromise({
          try: () =>
            options.recall.search({
              botId: options.botId,
              text: parsed.value.query,
              limit: parsed.value.limit,
              mode: "auto",
            }),
          catch: (error) => error,
        });

        // The call's own limit bounds the answer, not only the policy cap: a
        // provider that returns more than it was asked for is cut to what the
        // model requested, and the dropped count is relative to that request.
        const bounded = boundRecallMatches(matches, {
          ...limits,
          maxMatches: parsed.value.limit,
        });

        return { ok: true, matches: bounded.matches, omitted: bounded.omitted };
      }),
  };

  const forget: ToolRegistration = {
    name: MEMORY_TOOL_NAMES.forget,
    description:
      "Ask to remove a memory document. Only the operator can delete memory, so an agent call " +
      "is refused by the rules and persists no revision; the request itself stays visible in " +
      "the tool-call timeline.",
    parameters: forgetParameters,
    maxDurationMs,
    execute: (call) =>
      Effect.gen(function* () {
        const parsed = parseForget(call.arguments);

        if (!parsed.ok) {
          return { ok: false, reason: "invalid_arguments", message: parsed.message };
        }

        const decision = yield* Effect.tryPromise({
          try: () =>
            options.proposals.propose(options.botId, {
              write: { action: "delete", documentId: parsed.value.documentId },
              reason: parsed.value.reason,
            }),
          catch: (error) => error,
        });

        return decisionResult(decision, parsed.value.documentId);
      }),
  };

  return [remember, recall, forget];
}

/**
 * Message rules: what makes a send valid, whether it starts a run, and when a
 * resubmitted send is a duplicate.
 *
 * PRD decision 5 makes the client nonce the idempotency key of a send: an
 * already-answered nonce replays the first result — or conflicts when it was
 * reused for different text — rather than creating a second message, and that
 * rule lives here, in one place. The thread rule follows story 20: a send that
 * reaches a thread with an active run is a steer, never a second concurrent
 * run, and the deduplication check comes first so a resubmit cannot turn into a
 * stray steer. Terminal runs start nothing: a status the run state machine
 * calls terminal is treated as if the thread were idle.
 *
 * Like the rest of this package, the decision is pure — it reads the context
 * the caller already looked up and returns what to do, and the database's
 * unique index remains the authority on which write wins a race.
 */

import { isActiveStatus, isRunStatus } from "./run-state.ts";
import type { RunStatus } from "./run-state.ts";

export const MAX_MESSAGE_TEXT_LENGTH = 32_000;
export const MAX_CLIENT_NONCE_LENGTH = 200;

export interface SendMessageRequest {
  readonly text: string;
  readonly clientNonce: string;
}

export interface ActiveRun {
  readonly runId: string;
  readonly status: RunStatus;
}

/** What an earlier send with the same client nonce produced. */
export interface ExistingSend {
  readonly messageId: string;
  readonly runId: string;
  /** The request that created it, so a nonce stays bound to its content. */
  readonly request: SendMessageRequest;
}

export interface MessageContext {
  /** The thread's run in a non-terminal status, when one exists. */
  readonly activeRun?: ActiveRun | undefined;
  /**
   * Looked up by `(threadId, clientNonce)` — never by nonce alone, or one
   * thread's send would replay another thread's.
   */
  readonly existingSend?: ExistingSend | undefined;
}

/**
 * What the caller must do with a send. `start_run` creates the message and
 * its run, `steer` appends a steering message to the named run, and `replay`
 * returns the stored message and run untouched; the caller mints the ids it
 * persists.
 */
export type MessageAction =
  | { readonly action: "start_run" }
  | { readonly action: "steer"; readonly runId: string }
  | { readonly action: "replay"; readonly messageId: string; readonly runId: string };

export type MessageDecision =
  | { readonly ok: true; readonly action: MessageAction }
  | { readonly ok: false; readonly error: MessageRuleError };

export class MessageRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageRuleError";
  }
}

export class EmptyMessage extends MessageRuleError {
  constructor() {
    super("Message text must not be blank");
    this.name = "EmptyMessage";
  }
}

export class MessageTooLong extends MessageRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(`Message text is ${length} characters, above the ${MAX_MESSAGE_TEXT_LENGTH} limit`);
    this.name = "MessageTooLong";
    this.length = length;
    this.maxLength = MAX_MESSAGE_TEXT_LENGTH;
  }
}

export class MissingClientNonce extends MessageRuleError {
  constructor() {
    super("Message requires a non-empty client nonce");
    this.name = "MissingClientNonce";
  }
}

export class ClientNonceTooLong extends MessageRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(`Client nonce is ${length} characters, above the ${MAX_CLIENT_NONCE_LENGTH} limit`);
    this.name = "ClientNonceTooLong";
    this.length = length;
    this.maxLength = MAX_CLIENT_NONCE_LENGTH;
  }
}

export class ClientNonceReused extends MessageRuleError {
  readonly messageId: string;

  constructor(messageId: string) {
    super(`Client nonce was already used by message "${messageId}" for different text`);
    this.name = "ClientNonceReused";
    this.messageId = messageId;
  }
}

function validateRequest(request: SendMessageRequest): MessageRuleError | undefined {
  if (typeof request.text !== "string" || request.text.trim().length === 0) {
    return new EmptyMessage();
  }

  if (request.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    return new MessageTooLong(request.text.length);
  }

  if (typeof request.clientNonce !== "string" || request.clientNonce.trim().length === 0) {
    return new MissingClientNonce();
  }

  if (request.clientNonce.length > MAX_CLIENT_NONCE_LENGTH) {
    return new ClientNonceTooLong(request.clientNonce.length);
  }

  return undefined;
}

/**
 * Decides one send against the thread context the caller looked up. The nonce
 * is checked before the active run, so the same send reaching the server twice
 * is answered with the first result even while the run it started is live; a
 * nonce reused for different text is a conflict rather than a silent replay.
 * A status this build does not know counts as active, so an unrecognized value
 * steers an existing run instead of starting a second concurrent one.
 */
export function decideMessageSend(
  request: SendMessageRequest,
  context: MessageContext = {},
): MessageDecision {
  const invalid = validateRequest(request);
  if (invalid !== undefined) {
    return { ok: false, error: invalid };
  }

  const existing = context.existingSend;
  if (existing !== undefined) {
    if (existing.request.text !== request.text) {
      return { ok: false, error: new ClientNonceReused(existing.messageId) };
    }

    return {
      ok: true,
      action: { action: "replay", messageId: existing.messageId, runId: existing.runId },
    };
  }

  const active = context.activeRun;
  if (active !== undefined && (!isRunStatus(active.status) || isActiveStatus(active.status))) {
    return { ok: true, action: { action: "steer", runId: active.runId } };
  }

  return { ok: true, action: { action: "start_run" } };
}

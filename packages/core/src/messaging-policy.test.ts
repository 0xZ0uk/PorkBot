import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./files.ts";
import {
  ClientNonceReused,
  ClientNonceTooLong,
  decideMessageSend,
  EmptyMessage,
  MAX_CLIENT_NONCE_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MessageRuleError,
  MessageTooLong,
  MissingClientNonce,
  TooManyAttachments,
} from "./messaging-policy.ts";
import type {
  ActiveRun,
  ExistingSend,
  MessageContext,
  SendMessageRequest,
} from "./messaging-policy.ts";

const request: SendMessageRequest = { text: "summarise the inbox", clientNonce: "nonce-1" };

const storedSend: ExistingSend = {
  messageId: "msg-1",
  runId: "run-1",
  request,
};

const activeStatuses = ["queued", "running", "waiting_approval"] as const;
const terminalStatuses = ["completed", "failed", "cancelled"] as const;

function failure(input: SendMessageRequest, context: MessageContext = {}) {
  const decision = decideMessageSend(input, context);
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    throw new Error("expected the send to be refused");
  }

  return decision.error;
}

describe("decideMessageSend validity", () => {
  it("starts a run for a valid send on an idle thread", () => {
    expect(decideMessageSend(request)).toEqual({ ok: true, action: { action: "start_run" } });
  });

  it("refuses blank text", () => {
    for (const text of ["", " ", "\n\t  \n"]) {
      const error = failure({ ...request, text });
      expect(error).toBeInstanceOf(EmptyMessage);
      expect(error.name).toBe("EmptyMessage");
    }
  });

  it("refuses a missing or blank client nonce", () => {
    for (const clientNonce of ["", "   ", "\n"]) {
      const error = failure({ ...request, clientNonce });
      expect(error).toBeInstanceOf(MissingClientNonce);
      expect(error.name).toBe("MissingClientNonce");
    }
  });

  it("refuses a non-string text or nonce at runtime", () => {
    expect(
      failure({ text: 42 as unknown as string, clientNonce: request.clientNonce }),
    ).toBeInstanceOf(EmptyMessage);
    expect(failure({ text: request.text, clientNonce: null as unknown as string })).toBeInstanceOf(
      MissingClientNonce,
    );
  });

  it("bounds the text length inclusively", () => {
    const atLimit = { text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH), clientNonce: request.clientNonce };
    expect(decideMessageSend(atLimit)).toEqual({ ok: true, action: { action: "start_run" } });

    const overLimit = {
      text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
      clientNonce: request.clientNonce,
    };
    const error = failure(overLimit);
    expect(error).toBeInstanceOf(MessageTooLong);
    if (error instanceof MessageTooLong) {
      expect(error.length).toBe(MAX_MESSAGE_TEXT_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_MESSAGE_TEXT_LENGTH);
    }
  });

  it("bounds the nonce length inclusively", () => {
    const atLimit = { ...request, clientNonce: "n".repeat(MAX_CLIENT_NONCE_LENGTH) };
    expect(decideMessageSend(atLimit)).toEqual({ ok: true, action: { action: "start_run" } });

    const overLimit = { ...request, clientNonce: "n".repeat(MAX_CLIENT_NONCE_LENGTH + 1) };
    const error = failure(overLimit);
    expect(error).toBeInstanceOf(ClientNonceTooLong);
    if (error instanceof ClientNonceTooLong) {
      expect(error.length).toBe(MAX_CLIENT_NONCE_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_CLIENT_NONCE_LENGTH);
    }
  });

  it("validates before it considers the nonce a duplicate or a steer", () => {
    expect(
      failure({ text: "   ", clientNonce: request.clientNonce }, { existingSend: storedSend }),
    ).toBeInstanceOf(EmptyMessage);

    expect(
      failure(
        { text: "   ", clientNonce: request.clientNonce },
        { activeRun: { runId: "run-1", status: "running" } },
      ),
    ).toBeInstanceOf(EmptyMessage);
  });

  it("does not mutate its inputs", () => {
    const frozenRequest: SendMessageRequest = Object.freeze({
      text: "hello",
      clientNonce: "nonce-9",
    });
    const frozenContext: MessageContext = Object.freeze({
      activeRun: Object.freeze({ runId: "run-9", status: "running" as const }),
      existingSend: Object.freeze({
        messageId: "msg-9",
        runId: "run-9",
        request: frozenRequest,
      }),
    });

    expect(decideMessageSend(frozenRequest, frozenContext)).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-9", runId: "run-9" },
    });
  });
});

describe("decideMessageSend run start", () => {
  it("starts a run when the thread has no active run", () => {
    expect(decideMessageSend(request, {})).toEqual({ ok: true, action: { action: "start_run" } });
    expect(decideMessageSend(request, { activeRun: undefined })).toEqual({
      ok: true,
      action: { action: "start_run" },
    });
  });

  it("steers the active run instead of starting a second one", () => {
    for (const status of activeStatuses) {
      const activeRun: ActiveRun = { runId: `run-${status}`, status };
      expect(decideMessageSend(request, { activeRun })).toEqual({
        ok: true,
        action: { action: "steer", runId: activeRun.runId },
      });
    }
  });

  it("starts a run when the only run is terminal", () => {
    for (const status of terminalStatuses) {
      expect(decideMessageSend(request, { activeRun: { runId: "run-1", status } })).toEqual({
        ok: true,
        action: { action: "start_run" },
      });
    }
  });

  it("steers rather than starting a second run when the status is unknown", () => {
    const activeRun = { runId: "run-1", status: "bogus" as unknown as ActiveRun["status"] };

    expect(decideMessageSend(request, { activeRun })).toEqual({
      ok: true,
      action: { action: "steer", runId: "run-1" },
    });
  });
});

describe("decideMessageSend duplicate sends", () => {
  it("replays an earlier send with the same nonce instead of creating another", () => {
    const decision = decideMessageSend(request, { existingSend: storedSend });

    expect(decision).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-1", runId: "run-1" },
    });
  });

  it("replays before it steers, even while the first send's run is live", () => {
    const decision = decideMessageSend(request, {
      activeRun: { runId: "run-1", status: "running" },
      existingSend: storedSend,
    });

    expect(decision).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-1", runId: "run-1" },
    });
  });

  it("replays even when the stored run has since turned terminal", () => {
    const decision = decideMessageSend(request, {
      activeRun: { runId: "run-1", status: "completed" },
      existingSend: storedSend,
    });

    expect(decision).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-1", runId: "run-1" },
    });
  });

  it("refuses a nonce reused for different text instead of replaying", () => {
    const error = failure(
      { text: "delete the inbox", clientNonce: request.clientNonce },
      { existingSend: storedSend },
    );

    expect(error).toBeInstanceOf(ClientNonceReused);
    if (error instanceof ClientNonceReused) {
      expect(error.messageId).toBe("msg-1");
      expect(error.reason).toBe("different_text");
    }
  });

  it("replays a send whose attachment set is unchanged", () => {
    const withFile = { ...request, attachmentIds: ["attachment-1"] };
    const decision = decideMessageSend(withFile, {
      existingSend: { messageId: "msg-1", runId: "run-1", request: withFile },
    });

    expect(decision).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-1", runId: "run-1" },
    });
  });

  it("refuses a nonce reused with a different attachment set", () => {
    const error = failure(
      { ...request, attachmentIds: ["attachment-2"] },
      {
        existingSend: {
          messageId: "msg-1",
          runId: "run-1",
          request: { ...request, attachmentIds: ["attachment-1"] },
        },
      },
    );

    expect(error).toBeInstanceOf(ClientNonceReused);
    if (error instanceof ClientNonceReused) {
      expect(error.reason).toBe("different_attachments");
    }
  });

  it("refuses more attachments than one message may carry", () => {
    const attachmentIds = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
      (_value, index) => `attachment-${String(index)}`,
    );
    const error = failure({ ...request, attachmentIds });

    expect(error).toBeInstanceOf(TooManyAttachments);
    if (error instanceof TooManyAttachments) {
      expect(error.count).toBe(MAX_ATTACHMENTS_PER_MESSAGE + 1);
      expect(error.maxCount).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    }
  });

  it("replays a steer whose run row is gone with a null run id", () => {
    const decision = decideMessageSend(request, {
      existingSend: { ...storedSend, runId: null },
    });

    expect(decision).toEqual({
      ok: true,
      action: { action: "replay", messageId: "msg-1", runId: null },
    });
  });
});

describe("message rule errors", () => {
  it("are typed errors that name the rule they broke", () => {
    const errors: readonly MessageRuleError[] = [
      new EmptyMessage(),
      new MessageTooLong(MAX_MESSAGE_TEXT_LENGTH + 1),
      new MissingClientNonce(),
      new ClientNonceTooLong(MAX_CLIENT_NONCE_LENGTH + 1),
      new ClientNonceReused("msg-1"),
      new TooManyAttachments(MAX_ATTACHMENTS_PER_MESSAGE + 1),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(MessageRuleError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

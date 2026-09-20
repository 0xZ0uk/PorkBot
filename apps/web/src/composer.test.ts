import { ORPCError } from "@porkbot/contracts";
import type { Message, ThreadsSendResult, UploadedAttachment } from "@porkbot/contracts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { AttachmentUploadError, createComposer } from "./composer.ts";
import type { ComposerFileInput, ComposerTransport } from "./composer.ts";

/**
 * The composer's state machine, driven without a network: files stage as they
 * arrive, an intake refusal or an upload failure is a visible row rather than
 * a silent drop, an unsettled file holds the send, and the nonce pins the
 * draft to one send intent — an edit mints a new one, a retry of the same
 * draft replays it. The transport is a pair of deferred calls the test
 * resolves and refuses exactly.
 */

const threadId = "thread-1";

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/** A file input with a default name, type and small body. */
function fileInput(overrides: Partial<ComposerFileInput> = {}): ComposerFileInput {
  const body = new Blob(["contents"], { type: "text/plain" });

  return {
    filename: "notes.txt",
    contentType: "text/plain",
    sizeBytes: body.size,
    body,
    ...overrides,
  };
}

function uploaded(id: string, filename = "notes.txt"): UploadedAttachment {
  return { id, filename, contentType: "text/plain", sizeBytes: 8 };
}

function sentMessage(id: string, text: string): Message {
  return {
    id,
    threadId,
    seq: 1,
    role: "user",
    blocks: [{ type: "text", text }],
    runId: "run-1",
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

function sentResult(message: Message): ThreadsSendResult {
  return { action: "start_run", message, runId: "run-1" };
}

/** A transport whose calls are recorded and whose answers are deferred. */
function scriptedTransport(): {
  readonly transport: ComposerTransport;
  readonly sends: Parameters<ComposerTransport["send"]>[0][];
  readonly sendDeferreds: ReturnType<typeof deferred<ThreadsSendResult>>[];
  readonly uploads: {
    readonly input: Parameters<ComposerTransport["uploadAttachment"]>[0];
    readonly deferred: ReturnType<typeof deferred<UploadedAttachment>>;
  }[];
} {
  const sends: Parameters<ComposerTransport["send"]>[0][] = [];
  const sendDeferreds: ReturnType<typeof deferred<ThreadsSendResult>>[] = [];
  const uploads: {
    input: Parameters<ComposerTransport["uploadAttachment"]>[0];
    deferred: ReturnType<typeof deferred<UploadedAttachment>>;
  }[] = [];

  return {
    sends,
    sendDeferreds,
    uploads,
    transport: {
      send: (input) => {
        sends.push(input);
        const next = deferred<ThreadsSendResult>();
        sendDeferreds.push(next);
        return next.promise;
      },
      uploadAttachment: (input) => {
        const next = deferred<UploadedAttachment>();
        uploads.push({ input, deferred: next });
        return next.promise;
      },
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function composerFor(
  transport: ComposerTransport,
  options: { readonly onSent?: (message: Message) => void; readonly nonces?: string[] } = {},
) {
  let index = 0;
  const nonces = options.nonces ?? ["nonce-1", "nonce-2", "nonce-3", "nonce-4", "nonce-5"];

  return createComposer({
    transport,
    threadId,
    ...(options.onSent === undefined ? {} : { onSent: options.onSent }),
    newNonce: () => nonces[index++] ?? `nonce-${String(index)}`,
  });
}

describe("the composer", () => {
  it("keeps the send off until there is text", () => {
    const { transport } = scriptedTransport();
    const composer = composerFor(transport);

    expect(composer.state().canSend).toBe(false);

    composer.setText("  ");
    expect(composer.state().canSend).toBe(false);

    composer.setText("hello");
    expect(composer.state().canSend).toBe(true);
  });

  it("uploads a staged file and marks it ready with its attachment id", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput()]);

    expect(composer.state().files).toHaveLength(1);
    expect(composer.state().files[0]).toMatchObject({
      filename: "notes.txt",
      status: "uploading",
    });
    expect(uploads[0]?.input.filename).toBe("notes.txt");
    expect(uploads[0]?.input.contentType).toBe("text/plain");

    uploads[0]?.deferred.resolve(uploaded("attachment-1"));
    await tick();

    expect(composer.state().files[0]).toMatchObject({
      status: "ready",
      attachmentId: "attachment-1",
      progress: 1,
    });
  });

  it("reports upload progress as the transport reports it", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput({ sizeBytes: 100 })]);
    uploads[0]?.input.onProgress?.(25, 100);

    expect(composer.state().files[0]?.progress).toBe(0.25);
  });

  it("stages an oversized file as invalid and never uploads it", () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 })]);

    expect(uploads).toHaveLength(0);
    expect(composer.state().files[0]).toMatchObject({
      status: "invalid",
      attachmentId: null,
    });
    expect(composer.state().files[0]?.detail).toContain("8 MB");
  });

  it("stages files beyond the count as invalid", () => {
    const { transport } = scriptedTransport();
    const composer = composerFor(transport);
    const batch = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) =>
      fileInput({ filename: `file-${String(index)}.txt` }),
    );

    composer.addFiles(batch);

    const files = composer.state().files;
    expect(files).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE + 1);
    expect(files.at(-1)).toMatchObject({ status: "invalid" });
    expect(files.at(-1)?.detail).toContain("at most 8");
  });

  it("guesses the type from the filename when the input carries none", () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput({ filename: "report.pdf", contentType: "" })]);

    expect(uploads[0]?.input.contentType).toBe("application/pdf");
  });

  it("holds the send while an upload is in flight or failed", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("with a file");
    composer.addFiles([fileInput()]);

    expect(composer.state().canSend).toBe(false);

    uploads[0]?.deferred.reject(new AttachmentUploadError(500, "boom"));
    await tick();

    expect(composer.state().files[0]?.status).toBe("failed");
    expect(composer.state().files[0]?.detail).toContain("retry it or remove it");
    expect(composer.state().canSend).toBe(false);
    // The failure dropped nothing: the draft text is still there.
    expect(composer.state().text).toBe("with a file");
  });

  it("maps the upload's refusal status to the row's sentence", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([
      fileInput({ filename: "a.txt" }),
      fileInput({ filename: "b.txt" }),
      fileInput({ filename: "c.txt" }),
      fileInput({ filename: "d.txt" }),
    ]);

    uploads[0]?.deferred.reject(new AttachmentUploadError(413, "too large"));
    uploads[1]?.deferred.reject(new AttachmentUploadError(401, "signed out"));
    uploads[2]?.deferred.reject(new AttachmentUploadError(429, "slow down"));
    uploads[3]?.deferred.reject(new AttachmentUploadError(404, "gone"));
    await tick();

    const files = composer.state().files;
    expect(files[0]?.detail).toContain("8 MB");
    expect(files[1]?.detail).toContain("session has ended");
    expect(files[2]?.detail).toContain("Rate-limited");
    expect(files[3]?.detail).toContain("not available");
  });

  it("retries a failed upload", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput()]);
    uploads[0]?.deferred.reject(new AttachmentUploadError(null, "offline"));
    await tick();

    const failed = composer.state().files[0];

    expect(failed).toBeDefined();
    composer.retryFile(failed?.key ?? "");

    expect(composer.state().files[0]?.status).toBe("uploading");
    expect(uploads).toHaveLength(2);

    uploads[1]?.deferred.resolve(uploaded("attachment-9"));
    await tick();

    expect(composer.state().files[0]).toMatchObject({
      status: "ready",
      attachmentId: "attachment-9",
    });
  });

  it("removes a staged file and aborts its upload", async () => {
    const { transport, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.addFiles([fileInput()]);
    const key = composer.state().files[0]?.key ?? "";
    composer.removeFile(key);

    expect(composer.state().files).toHaveLength(0);
    expect(uploads[0]?.input.signal?.aborted).toBe(true);

    // A late resolution writes nowhere.
    uploads[0]?.deferred.resolve(uploaded("attachment-late"));
    await tick();
    expect(composer.state().files).toHaveLength(0);
  });

  it("sends the text and the settled attachments under one nonce", async () => {
    const { transport, sends, sendDeferreds, uploads } = scriptedTransport();
    const seen: Message[] = [];
    const composer = composerFor(transport, { onSent: (message) => seen.push(message) });

    composer.setText("take this");
    composer.addFiles([fileInput()]);
    uploads[0]?.deferred.resolve(uploaded("attachment-1"));
    await tick();

    composer.send();

    expect(composer.state().sending).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      threadId,
      text: "take this",
      attachmentIds: ["attachment-1"],
      clientNonce: "nonce-1",
    });

    sendDeferreds[0]?.resolve(sentResult(sentMessage("m-1", "take this")));
    await tick();

    expect(composer.state().sending).toBe(false);
    expect(composer.state().text).toBe("");
    expect(composer.state().files).toHaveLength(0);
    expect(seen.map((message) => message.id)).toEqual(["m-1"]);
  });

  it("keeps the draft when the send is refused", async () => {
    const { transport, sendDeferreds } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("keep me");
    composer.send();
    sendDeferreds[0]?.reject(
      new ORPCError("NOT_FOUND", { defined: true, status: 404, message: "gone" }),
    );
    await tick();

    expect(composer.state().sending).toBe(false);
    expect(composer.state().text).toBe("keep me");
    expect(composer.state().error).toBe("This thread is not available.");
  });

  it("retries once with the same nonce when the run ended mid-send", async () => {
    const { transport, sends, sendDeferreds } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("again");
    composer.send();
    sendDeferreds[0]?.reject(
      new ORPCError("PRECONDITION_FAILED", {
        defined: true,
        status: 412,
        message: "run over",
      }),
    );
    await tick();

    // One retry, same nonce: the steer that lost its run is replayed as the
    // send that starts a fresh one.
    expect(sends).toHaveLength(2);
    expect(sends[1]?.clientNonce).toBe("nonce-1");

    sendDeferreds[1]?.resolve(sentResult(sentMessage("m-2", "again")));
    await tick();

    expect(composer.state().error).toBeNull();
    expect(composer.state().text).toBe("");
  });

  it("surfaces a second precondition refusal rather than retrying forever", async () => {
    const { transport, sends, sendDeferreds } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("again");
    composer.send();
    sendDeferreds[0]?.reject(
      new ORPCError("PRECONDITION_FAILED", { defined: true, status: 412, message: "run over" }),
    );
    await tick();
    sendDeferreds[1]?.reject(
      new ORPCError("PRECONDITION_FAILED", { defined: true, status: 412, message: "run over" }),
    );
    await tick();

    expect(sends).toHaveLength(2);
    expect(composer.state().error).toBe("The run ended before this send landed; send again.");
    expect(composer.state().text).toBe("again");
  });

  it("mints a fresh nonce when the draft changes after a refusal", async () => {
    const { transport, sends, sendDeferreds } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("first");
    composer.send();
    sendDeferreds[0]?.reject(
      new ORPCError("CONFLICT", { defined: true, status: 409, message: "clash" }),
    );
    await tick();

    // A resend of the untouched draft replays the same nonce…
    composer.send();
    sendDeferreds[1]?.reject(new Error("offline"));
    await tick();
    expect(sends[1]?.clientNonce).toBe("nonce-1");

    // …and an edit mints a new one.
    composer.setText("second");
    composer.send();
    expect(sends[2]?.clientNonce).toBe("nonce-2");
  });

  it("keeps text typed and files staged while the send was in flight", async () => {
    const { transport, sendDeferreds, uploads } = scriptedTransport();
    const composer = composerFor(transport);

    composer.setText("sent");
    composer.send();
    composer.setText("sent plus more");
    composer.addFiles([fileInput({ filename: "later.txt" })]);

    sendDeferreds[0]?.resolve(sentResult(sentMessage("m-3", "sent")));
    await tick();

    expect(composer.state().text).toBe("sent plus more");
    expect(composer.state().files).toHaveLength(1);
    expect(composer.state().files[0]?.filename).toBe("later.txt");
    expect(uploads).toHaveLength(1);
  });

  it("does nothing when send is called with nothing to send", () => {
    const { transport, sends } = scriptedTransport();
    const composer = composerFor(transport);

    composer.send();
    composer.setText("   ");
    composer.send();

    expect(sends).toHaveLength(0);
  });
});

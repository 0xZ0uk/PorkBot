import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  contentTypeForFileName,
} from "@porkbot/core";
import { ORPCError } from "@porkbot/contracts";
import type { Message, ThreadsSendResult, UploadedAttachment } from "@porkbot/contracts";

/**
 * The message composer (slice 11.3, PRD stories 32 and 33): the text, the
 * files being attached, and the send itself, as one framework-free state
 * machine in the console's image — the controller owns every decision and the
 * screen is a pure function of its state.
 *
 * An attachment is uploaded when it is staged, not when the message is sent:
 * the send then addresses only settled attachment ids, each file's progress
 * and failure is its own row, and the `run.steered`/transcript merge the
 * console already owns shows the message's files once it lands. A file that
 * fails validation — over the size cap or past the count — stages as
 * `invalid` with its reason instead of being silently dropped, and one still
 * uploading or failed keeps `canSend` false, because a send that quietly left
 * a file behind is exactly the drop the story rules out.
 *
 * The nonce is the send's identity (PRD decision 5): it is minted once for a
 * draft, so a retry of the same content replays rather than duplicates, and
 * any edit — text or file set — mints a fresh one. A `PRECONDITION_FAILED`
 * answer means the addressed run finished before the steer landed and nothing
 * was written, so the controller retries the same nonce once itself: the
 * thread's now-idle state turns the retry into a fresh run.
 *
 * A send that lands clears only what it sent: text typed while the request
 * was in flight and files staged after it stay in the draft.
 */

/** One file offered to the composer, before it is a stored attachment. */
export interface ComposerFileInput {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The bytes, read by the upload itself. */
  readonly body: Blob;
}

/** A staged file's lifecycle: rejected at intake, in flight, stored, or failed. */
export type ComposerFileStatus = "invalid" | "uploading" | "ready" | "failed";

/** One staged file as the screen renders it. */
export interface ComposerFileView {
  readonly key: string;
  /** The stored name once uploaded, the offered name until then. */
  readonly filename: string;
  /** The type the row was stored with, or the guess a client makes of it. */
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: ComposerFileStatus;
  /** Sent fraction while `status` is `uploading`, 0 to 1. */
  readonly progress: number;
  /** The refusal or failure sentence for `invalid` and `failed`, else null. */
  readonly detail: string | null;
  /** The stored attachment id once `ready`; what the send references. */
  readonly attachmentId: string | null;
}

export interface ComposerState {
  readonly text: string;
  readonly files: readonly ComposerFileView[];
  /** True while a send request is in flight. */
  readonly sending: boolean;
  /**
   * Whether the send control is live: text present, no send in flight, and
   * every staged file settled as `ready` — a file still in flight or failed
   * holds the send rather than being left out of the message.
   */
  readonly canSend: boolean;
  /** The send-level failure sentence, or null. */
  readonly error: string | null;
  /** True while a dragged file is over the composer. */
  readonly dragActive: boolean;
}

/** The API surface the composer needs, narrow enough to fake without a network. */
export interface ComposerTransport {
  /** The contract's send: idempotent on `clientNonce`. */
  send(input: {
    readonly threadId: string;
    readonly text: string;
    readonly attachmentIds: readonly string[];
    readonly clientNonce: string;
  }): Promise<ThreadsSendResult>;
  /**
   * The raw upload route. Reports sent bytes through `onProgress`; `signal`
   * aborts it when the file is removed mid-flight. The rejection carries the
   * HTTP status when there is one (`AttachmentUploadError`).
   */
  uploadAttachment(input: {
    readonly threadId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly body: Blob;
    readonly onProgress?: ((sentBytes: number, totalBytes: number) => void) | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<UploadedAttachment>;
}

/**
 * An upload's refusal: the route answers plain JSON, not the RPC envelope, so
 * the transport wraps the status it saw — `null` when no response arrived —
 * and the controller turns it into the row's sentence.
 */
export class AttachmentUploadError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "AttachmentUploadError";
    this.status = status;
  }
}

export interface ComposerOptions {
  readonly transport: ComposerTransport;
  readonly threadId: string;
  /** Called with the persisted message after every successful send. */
  readonly onSent?: ((message: Message) => void) | undefined;
  /** The nonce mint, injected in tests; defaults to a random UUID. */
  readonly newNonce?: (() => string) | undefined;
}

export interface Composer {
  state(): ComposerState;
  subscribe(listener: () => void): () => void;
  setText(text: string): void;
  setDragActive(active: boolean): void;
  addFiles(inputs: readonly ComposerFileInput[]): void;
  removeFile(key: string): void;
  /** Re-uploads a `failed` file; a no-op for any other status. */
  retryFile(key: string): void;
  /** Sends the draft when `canSend`; a no-op otherwise. */
  send(): void;
}

interface StagedFile {
  readonly key: string;
  readonly input: ComposerFileInput;
  filename: string;
  contentType: string;
  readonly sizeBytes: number;
  status: ComposerFileStatus;
  progress: number;
  detail: string | null;
  attachmentId: string | null;
  abort: AbortController | null;
}

const megabyte = 1024 * 1024;
const sizeLimitLabel = `${String(MAX_ATTACHMENT_BYTES / megabyte)} MB`;

function toView(file: StagedFile): ComposerFileView {
  return {
    key: file.key,
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    progress: file.progress,
    detail: file.detail,
    attachmentId: file.attachmentId,
  };
}

function deriveCanSend(text: string, sending: boolean, files: readonly StagedFile[]): boolean {
  return text.trim().length > 0 && !sending && files.every((file) => file.status === "ready");
}

/** The reason an intake refused a file, or null when it may upload. */
function intakeRefusal(input: ComposerFileInput, staged: number): string | null {
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return `Too large — the limit is ${sizeLimitLabel}.`;
  }

  if (staged >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return `A message carries at most ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files.`;
  }

  return null;
}

/** The row's sentence for a failed upload, from the status the route answered. */
function uploadFailure(error: unknown): string {
  const status = error instanceof AttachmentUploadError ? error.status : null;

  switch (status) {
    case 401:
      return "The session has ended; sign in again.";
    case 404:
      return "This thread is not available.";
    case 413:
      return `Too large — the limit is ${sizeLimitLabel}.`;
    case 429:
      return "Rate-limited; retry in a moment.";
    default:
      return "Upload failed; retry it or remove it.";
  }
}

/** The composer's sentence for a failed send, from the typed refusal. */
function sendFailure(error: unknown): string {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "NOT_FOUND":
        return "This thread is not available.";
      case "UNAUTHORIZED":
        return "The session has ended; sign in again to send.";
      case "PRECONDITION_FAILED":
        return "The run ended before this send landed; send again.";
      case "RATE_LIMITED":
        return "Sends are rate-limited right now; try again in a moment.";
      default:
        break;
    }
  }

  return "The message could not be sent; the draft is kept.";
}

export function createComposer(options: ComposerOptions): Composer {
  const { transport, threadId } = options;
  const newNonce = options.newNonce ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let text = "";
  let files: StagedFile[] = [];
  let sending = false;
  let error: string | null = null;
  let dragActive = false;
  let nonce: string | null = null;
  let nextKey = 0;
  // The published view, rebuilt on every publish: `useSyncExternalStore`
  // compares snapshots by identity, so the state object must be stable until
  // something actually changes.
  let view = compute();

  function compute(): ComposerState {
    return {
      text,
      files: files.map(toView),
      sending,
      canSend: deriveCanSend(text, sending, files),
      error,
      dragActive,
    };
  }

  function publish(): void {
    view = compute();

    for (const listener of listeners) {
      listener();
    }
  }

  function state(): ComposerState {
    return view;
  }

  function replaceFile(key: string, update: (file: StagedFile) => StagedFile): void {
    files = files.map((file) => (file.key === key ? update(file) : file));
    publish();
  }

  function upload(staged: StagedFile): void {
    const abort = new AbortController();
    staged.abort = abort;
    const contentType =
      staged.input.contentType.trim() === ""
        ? contentTypeForFileName(staged.input.filename)
        : staged.input.contentType.trim();

    transport
      .uploadAttachment({
        threadId,
        filename: staged.input.filename,
        contentType,
        body: staged.input.body,
        onProgress: (sentBytes, totalBytes) => {
          replaceFile(staged.key, (file) => ({
            ...file,
            progress: totalBytes > 0 ? Math.min(1, sentBytes / totalBytes) : file.progress,
          }));
        },
        signal: abort.signal,
      })
      .then((uploaded) => {
        // A file removed mid-flight is gone from the list; its resolution
        // writes nowhere and the stored object stays unreferenced.
        if (!files.some((file) => file.key === staged.key)) {
          return;
        }

        replaceFile(staged.key, (file) => ({
          ...file,
          filename: uploaded.filename,
          contentType: uploaded.contentType,
          status: "ready",
          progress: 1,
          detail: null,
          attachmentId: uploaded.id,
          abort: null,
        }));
      })
      .catch((failure: unknown) => {
        if (!files.some((file) => file.key === staged.key)) {
          return;
        }

        replaceFile(staged.key, (file) => ({
          ...file,
          status: "failed",
          detail: uploadFailure(failure),
          abort: null,
        }));
      });
  }

  return {
    state,

    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    setText: (next) => {
      if (next === text) {
        return;
      }

      text = next;
      nonce = null;
      publish();
    },

    setDragActive: (active) => {
      if (active === dragActive) {
        return;
      }

      dragActive = active;
      publish();
    },

    addFiles: (inputs) => {
      let staged = files.length;

      for (const input of inputs) {
        const refusal = intakeRefusal(input, staged);
        staged += 1;

        const file: StagedFile = {
          key: `file-${String((nextKey += 1))}`,
          input,
          filename: input.filename,
          contentType:
            input.contentType.trim() === ""
              ? contentTypeForFileName(input.filename)
              : input.contentType.trim(),
          sizeBytes: input.sizeBytes,
          status: refusal === null ? "uploading" : "invalid",
          progress: 0,
          detail: refusal,
          attachmentId: null,
          abort: null,
        };

        files = [...files, file];

        if (refusal === null) {
          upload(file);
        }
      }

      if (inputs.length > 0) {
        nonce = null;
      }

      publish();
    },

    removeFile: (key) => {
      const file = files.find((candidate) => candidate.key === key);

      if (file === undefined) {
        return;
      }

      file.abort?.abort();
      files = files.filter((candidate) => candidate.key !== key);
      nonce = null;
      publish();
    },

    retryFile: (key) => {
      const file = files.find((candidate) => candidate.key === key);

      if (file === undefined || file.status !== "failed") {
        return;
      }

      file.status = "uploading";
      file.progress = 0;
      file.detail = null;
      upload(file);
      publish();
    },

    send: () => {
      if (!deriveCanSend(text, sending, files)) {
        return;
      }

      const sendNonce = nonce ?? newNonce();
      nonce = sendNonce;
      const sentText = text;
      const sentFiles = files;
      const attachmentIds = files
        .map((file) => file.attachmentId)
        .filter((id): id is string => id !== null);
      sending = true;
      error = null;
      publish();

      const attempt = async (): Promise<ThreadsSendResult> => {
        try {
          return await transport.send({
            threadId,
            text: sentText,
            attachmentIds,
            clientNonce: sendNonce,
          });
        } catch (failure) {
          // The steer lost its run between the decision and the write, and
          // nothing was appended: the same nonce sent again is the operator's
          // intent as a fresh run, not a duplicate.
          if (failure instanceof ORPCError && failure.code === "PRECONDITION_FAILED") {
            return transport.send({
              threadId,
              text: sentText,
              attachmentIds,
              clientNonce: sendNonce,
            });
          }

          throw failure;
        }
      };

      void attempt()
        .then((result) => {
          options.onSent?.(result.message);

          // Clear only what this send carried: text typed and files staged
          // while the request was in flight are the next draft, not this one.
          const sentKeys = new Set(sentFiles.map((file) => file.key));
          files = files.filter((file) => !sentKeys.has(file.key));
          if (text === sentText) {
            text = "";
          }

          sending = false;
          nonce = null;
          publish();
        })
        .catch((failure: unknown) => {
          sending = false;
          error = sendFailure(failure);
          publish();
        });
    },
  };
}

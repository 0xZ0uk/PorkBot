import { MAX_MESSAGE_TEXT_LENGTH } from "@porkbot/core";
import { Button, Card, Icon, IconButton, Input, Textarea } from "@porkbot/ui";
import { useRef } from "react";
import { cn } from "../lib/cn.ts";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ChangeEvent } from "react";
import type { ComposerFileInput, ComposerState } from "../composer.ts";

/**
 * The message composer (slice 11.3; design record, Conversation grammar): the
 * text area, the staged files and the send, plus the run's stop control while
 * a run is live. Every fact on screen is the controller's state — which files
 * are staged, which are still in flight, which failed and why, and whether the
 * send is live — so the render is the same whether a file arrived by drag,
 * the chooser, or a paste.
 *
 * The composer is the obvious place to type: it holds the emphasis of the
 * pane's bottom, its placeholder names the bot the message goes to, and
 * sending while a run is active steers that run — steering is just talking.
 * Stopping is the one destructive act, so it is its own control beside the
 * send, disabled from the moment the request is out until the run settles.
 *
 * Files stage as they arrive, and a staged row is the feedback the story asks
 * for before anything is sent: name, type, size, and the intake refusal when
 * the file could not be taken — an oversized or extra file is a visible row,
 * never a silent drop. Uploading rows carry a real progress bar; a failed row
 * says so and offers a retry. While any row is unsettled the send stays off,
 * because a send that quietly left a file behind is exactly the drop the
 * story rules out — and a failed send leaves the whole draft standing.
 *
 * The keyboard flow is the pointer flow: the chooser is a real button, Enter
 * sends (Shift+Enter stays a newline), every file row's retry and remove are
 * buttons, and the drop affordance doubles as a paste target, so nothing on
 * the composer requires a pointing device.
 */

export interface ComposerScreenProps {
  readonly state: ComposerState;
  /** The selected bot, so the placeholder says where the message goes. */
  readonly botName?: string | undefined;
  /** True while a run is active and can be asked to stop. */
  readonly canStop?: boolean | undefined;
  /** True between a stop request and the run settling. */
  readonly stopping?: boolean | undefined;
  /** The sentence a failed stop request produced, or null. */
  readonly stopError?: string | null | undefined;
  readonly onStop?: (() => void) | undefined;
  readonly onText: (text: string) => void;
  readonly onFiles: (files: readonly ComposerFileInput[]) => void;
  readonly onRemoveFile: (key: string) => void;
  readonly onRetryFile: (key: string) => void;
  readonly onSend: () => void;
  readonly onDragActive: (active: boolean) => void;
}

/** A picked, dropped or pasted `File` as the controller's intake shape. */
function toInput(file: File): ComposerFileInput {
  return {
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    body: file,
  };
}

function offer(
  fileList: FileList | readonly File[],
  onFiles: ComposerScreenProps["onFiles"],
): void {
  const files = Array.from(fileList, toInput);

  if (files.length > 0) {
    onFiles(files);
  }
}

export function ComposerScreen({
  state,
  botName,
  canStop = false,
  stopping = false,
  stopError = null,
  onStop,
  onText,
  onFiles,
  onRemoveFile,
  onRetryFile,
  onSend,
  onDragActive,
}: ComposerScreenProps) {
  const chooser = useRef<HTMLInputElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends; Shift+Enter stays a newline, the chat-composer convention.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    // Files on the clipboard stage beside the text; a text-only paste behaves
    // exactly as it always did.
    offer(event.clipboardData?.files ?? [], onFiles);
  }

  function onDragOver(event: DragEvent<HTMLElement>): void {
    if (event.dataTransfer?.types.includes("Files") === true) {
      event.preventDefault();
      onDragActive(true);
    }
  }

  function onDragLeave(event: DragEvent<HTMLElement>): void {
    // Leaving a child is not leaving the composer; only a pointer that moves
    // outside the form ends the affordance.
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      onDragActive(false);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    onDragActive(false);
    offer(event.dataTransfer?.files ?? [], onFiles);
  }

  function onChoose(event: ChangeEvent<HTMLInputElement>): void {
    offer(event.target.files ?? [], onFiles);
    // The same file chosen again must stage again, so the value goes back to
    // empty rather than suppressing the change event.
    event.target.value = "";
  }

  return (
    <form
      className={
        state.dragActive
          ? "mx-auto flex w-full max-w-xl flex-col gap-2 rounded-xl border border-border bg-card p-2 shadow-raised border-primary outline-2 outline-dashed"
          : "mx-auto flex w-full max-w-xl flex-col gap-2 rounded-xl border border-border bg-card p-2 shadow-raised"
      }
      aria-label="Message composer"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      {state.files.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {state.files.map((file) => (
            <Card
              as="li"
              variant="raised"
              key={file.key}
              data-composer-file
              className={cn(
                "flex flex-row flex-wrap items-center gap-2 rounded-md bg-background px-2 py-1 text-body",
                file.status === "invalid" && "border-destructive",
                file.status === "failed" && "border-destructive",
              )}
            >
              <span className="font-medium wrap-anywhere">{file.filename}</span>
              <span className="text-meta text-muted-foreground">
                {file.contentType} · {formatBytes(file.sizeBytes)}
              </span>
              {file.status === "uploading" ? (
                <progress
                  className="h-2 min-w-24 flex-1 accent-primary"
                  value={file.progress}
                  max={1}
                  aria-label={`Uploading ${file.filename}`}
                />
              ) : null}
              {file.detail === null ? null : (
                <span className="text-destructive" role="alert">
                  {file.detail}
                </span>
              )}
              {file.status === "failed" ? (
                <Button
                  onClick={() => {
                    onRetryFile(file.key);
                  }}
                >
                  Retry
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="ml-auto p-0 text-meta text-muted-foreground underline"
                aria-label={`Remove ${file.filename}`}
                onClick={() => {
                  onRemoveFile(file.key);
                }}
              >
                Remove
              </Button>
            </Card>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          className="flex-1 resize-y border-transparent bg-transparent focus-visible:border-primary"
          aria-label="Message"
          placeholder={botName === undefined ? "Message the bot" : `Message ${botName}`}
          value={state.text}
          maxLength={MAX_MESSAGE_TEXT_LENGTH}
          rows={2}
          onChange={(event) => {
            onText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <Input
          ref={chooser}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={onChoose}
        />
        <Button
          onClick={() => {
            chooser.current?.click();
          }}
        >
          <Icon name="plus" size={14} />
          Attach files
        </Button>
        {canStop && onStop !== undefined ? (
          <IconButton
            label={stopping ? "Stopping the run" : "Stop the run"}
            icon="stop"
            disabled={stopping}
            onClick={onStop}
          />
        ) : null}
        <Button variant="primary" type="submit" disabled={!state.canSend}>
          {state.sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {stopError === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {stopError}
        </p>
      )}
      {state.error === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }

  const kib = bytes / 1_024;

  return kib < 1_024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1_024).toFixed(1)} MiB`;
}

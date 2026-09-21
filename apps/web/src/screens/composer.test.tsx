// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerFileInput, ComposerState } from "../composer.ts";
import { ComposerScreen } from "./composer.tsx";

/**
 * The composer screen in a real DOM: the staged-file rows carry the intake
 * refusal, the upload's progress and its failure, the chooser, the drop zone
 * and the paste path all feed the same callback, and the keyboard flow —
 * type, Enter to send, real buttons for everything else — needs no pointer.
 * The controller's decisions are faked state here; what is proven is that the
 * render and the events are wired to it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    text: "",
    files: [],
    sending: false,
    canSend: false,
    error: null,
    dragActive: false,
    ...overrides,
  };
}

function handlers() {
  return {
    onText: vi.fn(),
    onFiles: vi.fn(),
    onRemoveFile: vi.fn(),
    onRetryFile: vi.fn(),
    onSend: vi.fn(),
    onDragActive: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector("textarea");

  expect(element).not.toBeNull();
  return element as HTMLTextAreaElement;
}

function sendButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.type === "submit",
  );

  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

function fileEvent(files: readonly File[]): { files: FileList } {
  // jsdom has no FileList constructor; the handlers only read `length` and
  // index, so a plain array stands in.
  return { files: files as unknown as FileList };
}

function pasteEvent(files: readonly File[]): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });

  Object.defineProperty(event, "clipboardData", { value: fileEvent(files) });
  return event;
}

function dropEvent(files: readonly File[]): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });

  Object.defineProperty(event, "dataTransfer", { value: fileEvent(files) });
  return event;
}

describe("the composer screen", () => {
  it("renders the message field, the chooser button and a disabled send", async () => {
    await render(<ComposerScreen state={state()} {...handlers()} />);

    expect(textarea().getAttribute("aria-label")).toBe("Message");
    expect(sendButton().disabled).toBe(true);
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Attach files",
      ),
    ).toBe(true);
  });

  it("names the bot in the placeholder", async () => {
    await render(<ComposerScreen state={state()} botName="Ada" {...handlers()} />);

    expect(textarea().getAttribute("placeholder")).toBe("Message Ada");

    await render(<ComposerScreen state={state()} {...handlers()} />);

    expect(textarea().getAttribute("placeholder")).toBe("Message the bot");
  });

  it("offers the stop control while a run is active and reports the request", async () => {
    const onStop = vi.fn();

    await render(<ComposerScreen state={state()} canStop onStop={onStop} {...handlers()} />);

    const stop = container.querySelector("button[aria-label='Stop the run']");

    expect(stop).not.toBeNull();

    await act(async () => {
      (stop as HTMLButtonElement).click();
    });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("holds the stop control while the request is out and shows its refusal", async () => {
    await render(
      <ComposerScreen
        state={state()}
        canStop
        stopping
        stopError="The stop could not be requested; try again."
        onStop={vi.fn()}
        {...handlers()}
      />,
    );

    const stop = container.querySelector(
      "button[aria-label='Stopping the run']",
    ) as HTMLButtonElement;

    expect(stop.disabled).toBe(true);
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The stop could not be requested; try again.",
    );
  });

  it("shows no stop control when no run is active", async () => {
    await render(<ComposerScreen state={state()} {...handlers()} />);

    expect(container.querySelector("button[aria-label='Stop the run']")).toBeNull();
  });

  it("reports typing and sends on Enter, never on Shift+Enter", async () => {
    const calls = handlers();

    await render(<ComposerScreen state={state({ text: "hi", canSend: true })} {...calls} />);

    const field = textarea();
    // A controlled field's value goes through the prototype setter: React's
    // own tracker otherwise sees "no change" and swallows the input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

    setter?.call(field, "hi there");

    await act(async () => {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // React's onChange is the input event; the handler saw the new value.
    expect(calls.onText).toHaveBeenCalledWith("hi there");

    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(calls.onSend).not.toHaveBeenCalled();

    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(calls.onSend).toHaveBeenCalledTimes(1);
  });

  it("stages files chosen through the file input", async () => {
    const calls = handlers();

    await render(<ComposerScreen state={state()} {...calls} />);

    const chooser = container.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["data"], "report.pdf", { type: "application/pdf" });

    Object.defineProperty(chooser, "files", { value: [file], configurable: true });

    await act(async () => {
      chooser.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(calls.onFiles).toHaveBeenCalledTimes(1);

    const offered = calls.onFiles.mock.calls[0]?.[0] as ComposerFileInput[];

    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 4,
    });
    expect(offered[0]?.body).toBe(file);
  });

  it("stages dropped files and flags the drop affordance while over it", async () => {
    const calls = handlers();

    await render(<ComposerScreen state={state()} {...calls} />);

    const form = container.querySelector("form") as HTMLFormElement;
    const over = new Event("dragover", { bubbles: true, cancelable: true });

    Object.defineProperty(over, "dataTransfer", { value: { types: ["Files"], files: [] } });

    await act(async () => {
      form.dispatchEvent(over);
    });

    expect(calls.onDragActive).toHaveBeenCalledWith(true);

    const file = new File(["x"], "clip.txt", { type: "text/plain" });

    await act(async () => {
      form.dispatchEvent(dropEvent([file]));
    });

    expect(calls.onDragActive).toHaveBeenCalledWith(false);
    expect(calls.onFiles).toHaveBeenCalledTimes(1);
    expect((calls.onFiles.mock.calls[0]?.[0] as ComposerFileInput[])[0]?.filename).toBe("clip.txt");
  });

  it("stages pasted files from the textarea", async () => {
    const calls = handlers();

    await render(<ComposerScreen state={state()} {...calls} />);

    await act(async () => {
      textarea().dispatchEvent(pasteEvent([new File(["img"], "shot.png", { type: "image/png" })]));
    });

    expect(calls.onFiles).toHaveBeenCalledTimes(1);
    expect((calls.onFiles.mock.calls[0]?.[0] as ComposerFileInput[])[0]).toMatchObject({
      filename: "shot.png",
      contentType: "image/png",
    });
  });

  it("renders each staged file with its type, size and state", async () => {
    await render(
      <ComposerScreen
        state={state({
          files: [
            {
              key: "file-1",
              filename: "notes.txt",
              contentType: "text/plain",
              sizeBytes: 2_048,
              status: "uploading",
              progress: 0.5,
              detail: null,
              attachmentId: null,
            },
            {
              key: "file-2",
              filename: "huge.bin",
              contentType: "application/octet-stream",
              sizeBytes: 9_000_000,
              status: "invalid",
              progress: 0,
              detail: "Too large — the limit is 8 MB.",
              attachmentId: null,
            },
            {
              key: "file-3",
              filename: "lost.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "failed",
              progress: 0,
              detail: "Upload failed; retry it or remove it.",
              attachmentId: null,
            },
            {
              key: "file-4",
              filename: "ready.txt",
              contentType: "text/plain",
              sizeBytes: 8,
              status: "ready",
              progress: 1,
              detail: null,
              attachmentId: "attachment-1",
            },
          ],
        })}
        {...handlers()}
      />,
    );

    const rows = [...container.querySelectorAll(".composer-file")];

    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("notes.txt");
    expect(rows[0]?.textContent).toContain("text/plain · 2.0 KiB");
    expect(rows[0]?.querySelector("progress")?.getAttribute("value")).toBe("0.5");
    expect(rows[1]?.className).toContain("composer-file-invalid");
    expect(rows[1]?.textContent).toContain("Too large — the limit is 8 MB.");
    expect(rows[2]?.className).toContain("composer-file-failed");
    expect(rows[2]?.textContent).toContain("Upload failed; retry it or remove it.");
    expect(rows[3]?.className).toContain("composer-file-ready");
  });

  it("wires retry and remove on a failed row", async () => {
    const calls = handlers();

    await render(
      <ComposerScreen
        state={state({
          files: [
            {
              key: "file-9",
              filename: "lost.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "failed",
              progress: 0,
              detail: "Upload failed; retry it or remove it.",
              attachmentId: null,
            },
          ],
        })}
        {...calls}
      />,
    );

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    const remove = container.querySelector("button[aria-label='Remove lost.txt']");

    await act(async () => {
      retry?.click();
    });
    await act(async () => {
      (remove as HTMLButtonElement | null)?.click();
    });

    expect(calls.onRetryFile).toHaveBeenCalledWith("file-9");
    expect(calls.onRemoveFile).toHaveBeenCalledWith("file-9");
  });

  it("shows the send's refusal as an alert and keeps the draft visible", async () => {
    await render(
      <ComposerScreen
        state={state({
          text: "still here",
          error: "The message could not be sent; the draft is kept.",
        })}
        {...handlers()}
      />,
    );

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The message could not be sent; the draft is kept.",
    );
    expect(textarea().value).toBe("still here");
  });

  it("sends through the submit control", async () => {
    const calls = handlers();

    await render(<ComposerScreen state={state({ canSend: true })} {...calls} />);

    await act(async () => {
      sendButton().click();
    });

    expect(calls.onSend).toHaveBeenCalledTimes(1);
  });
});

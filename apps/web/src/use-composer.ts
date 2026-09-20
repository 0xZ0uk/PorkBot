import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Message } from "@porkbot/contracts";
import { createComposer } from "./composer.ts";
import type { ComposerFileInput, ComposerState, ComposerTransport } from "./composer.ts";

/**
 * The React binding for `createComposer`: it mounts the controller the screen
 * renders, feeds it the transport and thread id, and folds each sent message
 * back through `onSent` — the console's `noteSent`. Unmounting drops the
 * controller; the draft lives only as long as the route does.
 */
export function useComposer(
  transport: ComposerTransport,
  threadId: string,
  onSent: (message: Message) => void,
): {
  readonly state: ComposerState;
  readonly setText: (text: string) => void;
  readonly setDragActive: (active: boolean) => void;
  readonly addFiles: (inputs: readonly ComposerFileInput[]) => void;
  readonly removeFile: (key: string) => void;
  readonly retryFile: (key: string) => void;
  readonly send: () => void;
} {
  const composer = useMemo(
    () => createComposer({ transport, threadId, onSent }),
    [transport, threadId, onSent],
  );

  const state = useSyncExternalStore(composer.subscribe, composer.state, composer.state);

  return {
    state,
    setText: useCallback((text: string) => composer.setText(text), [composer]),
    setDragActive: useCallback((active: boolean) => composer.setDragActive(active), [composer]),
    addFiles: useCallback(
      (inputs: readonly ComposerFileInput[]) => composer.addFiles(inputs),
      [composer],
    ),
    removeFile: useCallback((key: string) => composer.removeFile(key), [composer]),
    retryFile: useCallback((key: string) => composer.retryFile(key), [composer]),
    send: useCallback(() => composer.send(), [composer]),
  };
}

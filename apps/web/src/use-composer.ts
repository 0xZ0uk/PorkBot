import { useCallback, useMemo, useSyncExternalStore } from "react";
import { createComposer } from "./composer.ts";
import type {
  ComposerFileInput,
  ComposerState,
  ComposerTransport,
  ComposerOptions,
} from "./composer.ts";

/**
 * The React binding for `createComposer`: it mounts the controller the screen
 * renders, feeds it the transport and thread id, and reports the send lifecycle
 * through the options — the console can show a local send, settle it, or mark
 * it failed. Unmounting drops the controller; the draft lives only as long as
 * the route does.
 */
export interface UseComposerOptions {
  readonly onOptimistic?: ComposerOptions["onOptimistic"];
  readonly onSent?: ComposerOptions["onSent"];
  readonly onSendFailed?: ComposerOptions["onSendFailed"];
}

export function useComposer(
  transport: ComposerTransport,
  threadId: string,
  options: UseComposerOptions,
): {
  readonly state: ComposerState;
  readonly setText: (text: string) => void;
  readonly setDragActive: (active: boolean) => void;
  readonly addFiles: (inputs: readonly ComposerFileInput[]) => void;
  readonly removeFile: (key: string) => void;
  readonly retryFile: (key: string) => void;
  readonly send: () => void;
} {
  const { onOptimistic, onSent, onSendFailed } = options;
  const composer = useMemo(
    () => createComposer({ transport, threadId, onOptimistic, onSent, onSendFailed }),
    [transport, threadId, onOptimistic, onSent, onSendFailed],
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

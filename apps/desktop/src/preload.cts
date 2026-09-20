/**
 * The preload bridge (slice 11.6).
 *
 * A sandboxed preload cannot `require` a sibling module — its `require` is a
 * polyfill limited to a few Electron and Node built-ins — so the channel name
 * `porkbot:run-event` is written here as a literal and `bridge.ts` owns the
 * other end. `hardening.test.ts` reads both files and fails when the literal
 * and `runEventChannel` disagree, because a silent drift would leave the tray
 * and the notifications quietly dead.
 *
 * The file is `.cts` because a sandboxed preload is CommonJS, and
 * `verbatimModuleSyntax` forbids ESM syntax in a CommonJS file: the Electron
 * surface is therefore pulled in with `require`, typed through type-only
 * imports, and the package's eslint config switches off exactly that one rule
 * for this one file.
 *
 * The exposed surface is deliberately one function: the renderer can say "this
 * run settled", and nothing else. No Node, no filesystem, no way back into main
 * beyond a channel main chooses to listen on.
 */

import type { ContextBridge, IpcRenderer } from "electron";
import type { RunEvent } from "@porkbot/core";

const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: ContextBridge;
  ipcRenderer: IpcRenderer;
};

contextBridge.exposeInMainWorld("porkbot", {
  forwardRunEvent: (event: RunEvent): void => {
    ipcRenderer.send("porkbot:run-event", event);
  },
});

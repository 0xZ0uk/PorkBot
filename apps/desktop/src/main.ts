/**
 * The desktop shell (slice 11.6).
 *
 * This is the only file that touches Electron's app lifecycle. Everything it
 * decides lives in a module beside it: the window flags and content security
 * policy in `hardening.ts`, the navigation rules in `navigation.ts`, the
 * loopback origin that serves the packaged build and proxies the API in
 * `proxy.ts`, the update check in `update-controller.ts`, the tray in `tray.ts`
 * and the notification mapping in `run-notifications.ts`. What is left here is
 * wiring, and the wiring refuses to start a window the hardening contract does
 * not bless.
 *
 * Topology, stated because the absence is part of the slice: this is
 * connect-only. The app hosts the same web build the deployment serves and
 * dials the operator's server; it runs no supervisor, no computer and no
 * worker on this machine. The "run here" topology is deferred to v1.1
 * (`docs/desktop.md`, PRD open question 1).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";
import type { IpcMainEvent } from "electron";
import type { RunEvent } from "@porkbot/core";
import { runEventChannel } from "./bridge.ts";
import { resolveClientRoot } from "./client-root.ts";
import { assertHardened, hardenWebPreferences } from "./hardening.ts";
import { decideNavigation } from "./navigation.ts";
import { createAppServer, setupPagePath } from "./proxy.ts";
import { isSettledRunEvent, notificationForRunEvent } from "./run-notifications.ts";
import { readSettings, settingsFilePath, writeSettings } from "./settings.ts";
import { trayIconDataUrl } from "./tray-icon.ts";
import { trayMenuTemplate, trayTooltip } from "./tray.ts";
import { createUpdateController } from "./update-controller.ts";

/** Permissions a page may still ask for: copying text and going fullscreen. */
const allowedPermissions = new Set(["clipboard-sanitized-write", "fullscreen"]);

const appDirectory = path.resolve(import.meta.dirname ?? ".", "..");

function logNote(message: string): void {
  // The desktop has no logger of its own and must not print a response body or
  // a header; Electron's main-process console is the operator's terminal.
  process.stdout.write(`${JSON.stringify({ service: "@porkbot/desktop", message })}\n`);
}

function asRunEvent(payload: unknown): RunEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as { type?: unknown; runId?: unknown; threadId?: unknown };

  if (
    typeof candidate.type !== "string" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.threadId !== "string"
  ) {
    return null;
  }

  return payload as RunEvent;
}

interface TrayContext {
  readonly window: BrowserWindow;
  readonly tray: Tray;
  /** The loopback origin the packaged build is served from. */
  readonly appOrigin: string;
  readonly activeRuns: Set<string>;
}

function refreshTray(context: TrayContext): void {
  const state = {
    windowVisible: context.window.isVisible(),
    activeRuns: context.activeRuns.size,
  };

  context.tray.setToolTip(trayTooltip(state));
  context.tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenuTemplate(state).map((item) =>
        item.type === "separator"
          ? { type: "separator" as const }
          : {
              label: item.label,
              enabled: item.enabled,
              click: () => handleTrayAction(context, item.id),
            },
      ),
    ),
  );
}

function handleTrayAction(context: TrayContext, id: "open" | "server" | "updates" | "quit"): void {
  switch (id) {
    case "open":
      if (context.window.isVisible()) {
        context.window.hide();
      } else {
        context.window.show();
        context.window.focus();
      }

      refreshTray(context);
      return;
    case "server":
      context.window.show();
      context.window.focus();
      void context.window.loadURL(`${context.appOrigin}${setupPagePath}`);
      return;
    case "updates":
      void checkForUpdates(context.window);
      return;
    case "quit":
      app.quit();
  }
}

async function checkForUpdates(window: BrowserWindow): Promise<void> {
  const controller = createUpdateController({
    feedUrl: process.env["PORKBOT_DESKTOP_UPDATE_FEED"],
    publicKey: process.env["PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY"],
    currentVersion: app.getVersion(),
    downloadDirectory: path.join(app.getPath("userData"), "updates"),
    log: logNote,
  });

  const result = await controller.check();

  switch (result.status) {
    case "ready": {
      const choice = await dialog.showMessageBox(window, {
        type: "info",
        message: `PorkBot ${result.version} is ready to install.`,
        buttons: ["Install", "Later"],
        defaultId: 0,
        cancelId: 1,
      });

      if (choice.response === 0) {
        await shell.openPath(result.artifactPath);
      }

      return;
    }
    case "refused":
      await dialog.showMessageBox(window, { type: "warning", message: result.message });
      return;
    case "not_configured":
      await dialog.showMessageBox(window, {
        type: "info",
        message: "This build has no signed update feed configured.",
      });
      return;
    case "up_to_date":
      await dialog.showMessageBox(window, {
        type: "info",
        message: `PorkBot ${result.version} is up to date.`,
      });
  }
}

async function start(): Promise<void> {
  app.setAppUserModelId("com.porkbot.desktop");

  const clientRoot = resolveClientRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDirectory,
  });

  if (!existsSync(path.join(clientRoot, "_shell.html"))) {
    throw new Error(
      `The packaged web build is missing at ${clientRoot}. Run pnpm build before starting the desktop app.`,
    );
  }

  const settingsFile = settingsFilePath(app.getPath("userData"));
  const stored = await readSettings(settingsFile);
  let serverOrigin = stored.serverOrigin;

  const server = createAppServer({
    clientRoot,
    serverOrigin: () => serverOrigin,
    saveServerOrigin: async (origin) => {
      serverOrigin = origin;
      await writeSettings(settingsFile, { serverOrigin: origin });
    },
    log: logNote,
  });

  const port = await server.listen(0);
  const appOrigin = `http://127.0.0.1:${port}`;

  const preferences = hardenWebPreferences({
    preload: path.join(import.meta.dirname ?? ".", "preload.cjs"),
    backgroundThrottling: false,
  });
  assertHardened(preferences);

  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    show: false,
    title: "PorkBot",
    webPreferences: preferences,
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));

  const tray = new Tray(nativeImage.createFromDataURL(trayIconDataUrl));
  const context: TrayContext = { window, tray, appOrigin, activeRuns: new Set<string>() };

  window.once("ready-to-show", () => {
    window.show();
    refreshTray(context);
  });
  window.on("show", () => refreshTray(context));
  window.on("hide", () => refreshTray(context));

  window.webContents.on("will-frame-navigate", (details) => {
    const decision = decideNavigation({
      url: details.url,
      appOrigin,
      frame: details.isMainFrame ? "main" : "subframe",
    });

    if (decision.action === "open-external") {
      details.preventDefault();
      void shell.openExternal(decision.url);
      return;
    }

    if (decision.action === "deny") {
      details.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation({ url, appOrigin, frame: "main" });

    if (decision.action === "open-external") {
      void shell.openExternal(decision.url);
    }

    return { action: "deny" };
  });

  ipcMain.on(runEventChannel, (event: IpcMainEvent, payload: unknown) => {
    if (event.sender !== window.webContents) {
      return;
    }

    const runEvent = asRunEvent(payload);

    if (runEvent === null) {
      return;
    }

    if (runEvent.type === "run.started") {
      context.activeRuns.add(runEvent.runId);
    }

    if (isSettledRunEvent(runEvent)) {
      context.activeRuns.delete(runEvent.runId);
    }

    refreshTray(context);

    const notification = notificationForRunEvent(runEvent);

    if (notification !== null && (!window.isVisible() || !window.isFocused())) {
      const shown = new Notification({ title: notification.title, body: notification.body });
      shown.on("click", () => {
        window.show();
        window.focus();
      });
      shown.show();
    }
  });

  refreshTray(context);
  Menu.setApplicationMenu(null);

  await window.loadURL(serverOrigin === null ? `${appOrigin}${setupPagePath}` : `${appOrigin}/`);
}

function reportStartFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "The desktop app could not start.";
  logNote(message);
  dialog.showErrorBox("PorkBot could not start", message);
  app.exit(1);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const windows = BrowserWindow.getAllWindows();

    if (windows[0] !== undefined) {
      windows[0].show();
      windows[0].focus();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    const windows = BrowserWindow.getAllWindows();

    if (windows[0] !== undefined) {
      windows[0].show();
    }
  });

  void app.whenReady().then(start).catch(reportStartFailure);
}

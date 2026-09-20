/**
 * The packaged-app smoke test (slice 11.7).
 *
 * The pipeline's artifacts are only real if the packaged app starts, so this
 * walks the app's own first-run flow against a running server: the setup screen
 * appears, the server address is entered and submitted through the page's own
 * form, and the next screen it can only reach by loading the packaged web build
 * and round-tripping an RPC call — the sign-in screen — appears. A broken
 * bundle, a missing client resource, a refused proxy path or an unreachable
 * server all stop at the second assertion.
 *
 * The renderer is driven through the Chrome DevTools Protocol rather than a
 * test hook in the app: the shipped code has no smoke mode, and what the
 * assertions read is the DOM the operator would see. The process is started
 * with its own `XDG_CONFIG_HOME`, so the run always begins on the setup screen
 * and never touches a real installation's settings.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cdpHttpBase, connectToPage, devToolsWebSocketUrl } from "./cdp.ts";
import type { CdpSession } from "./cdp.ts";

/** The setup page's heading; its presence means the shell served its own UI. */
export const setupScreenTitle = "Connect PorkBot";

/** The web build's sign-in heading; only reachable through the server round trip. */
export const signedOutScreenTitle = "Sign in";

export interface SmokeDriver {
  /** The visible text of the main frame. */
  readText(): Promise<string>;
  /** Fills the setup form and submits it; false when there is no form. */
  setServerOrigin(origin: string): Promise<boolean>;
}

export interface SmokeFlowOptions {
  readonly serverUrl: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly log?: (message: string) => void;
}

const defaultTimeoutMs = 30_000;
const defaultPollMs = 250;

function clip(text: string, length = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();

  return collapsed.length <= length ? collapsed : `${collapsed.slice(0, length)}…`;
}

/** Polls the frame until its text contains `expected`; throws with what it saw. */
export async function waitForText(
  driver: SmokeDriver,
  expected: string,
  options: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const observed = await driver.readText();

    if (observed.includes(expected)) {
      return observed;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the app never showed "${expected}" within ${options.timeoutMs}ms; ` +
          `the page said: "${clip(observed)}".`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** The flow's assertions, over any driver; the packaged app supplies the real one. */
export async function runSmokeFlow(driver: SmokeDriver, options: SmokeFlowOptions): Promise<void> {
  const log = options.log ?? ((): void => {});
  const timings = {
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    pollMs: options.pollMs ?? defaultPollMs,
  };

  log("waiting for the first-run screen");
  await waitForText(driver, setupScreenTitle, timings);

  log(`entering the server address ${options.serverUrl}`);
  const submitted = await driver.setServerOrigin(options.serverUrl);

  if (!submitted) {
    throw new Error("the setup page had no server address form to submit.");
  }

  log("waiting for the sign-in screen through the packaged client");
  await waitForText(driver, signedOutScreenTitle, timings);
}

export interface DesktopSmokeOptions {
  /** The packaged executable to launch. */
  readonly appPath: string;
  /** The running PorkBot server the app is pointed at. */
  readonly serverUrl: string;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The smoke test dials one thing: the local server it was told to use. It
 * refuses anything that is not loopback HTTP, so the register entry that
 * exempts it from the URL-safety rule describes exactly what it does rather
 * than what a caller might pass.
 */
export function localServerOrigin(serverUrl: string): string {
  let url: URL;

  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`"${serverUrl}" is not a server URL.`);
  }

  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error(
      `the smoke test only dials a loopback HTTP server, and "${serverUrl}" is not one.`,
    );
  }

  return url.origin;
}

/** The setup form's submit, typed into the page the operator would type into. */
function submitServerOrigin(origin: string): string {
  return `(() => {
    const input = document.querySelector("#origin");
    const form = document.querySelector("form");
    if (input === null || form === null) {
      return false;
    }
    input.value = ${JSON.stringify(origin)};
    form.requestSubmit();
    return true;
  })()`;
}

function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const killed = setTimeout(() => child.kill("SIGKILL"), 5_000);

    child.once("exit", () => {
      clearTimeout(killed);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts the packaged app under the current display, drives the first-run flow
 * against `serverUrl`, and stops it. The server must already be running; the
 * check is here rather than after launch so an unreachable server fails as
 * itself instead of as a screen that never changed.
 */
export async function smokeDesktopApp(options: DesktopSmokeOptions): Promise<void> {
  const log = options.log ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? 45_000;
  const serverUrl = localServerOrigin(options.serverUrl);

  const health = await fetch(new URL("/healthz", serverUrl)).catch(() => undefined);

  if (health === undefined || !health.ok) {
    throw new Error(`the server at ${serverUrl} did not answer /healthz.`);
  }

  const configHome = mkdtempSync(path.join(tmpdir(), "porkbot-desktop-smoke-"));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome };

  // A smoke run must never inherit a "run this binary as Node" flag: Electron
  // would start as Node and print its version instead of opening a window.
  delete env["ELECTRON_RUN_AS_NODE"];

  const child = spawn(
    options.appPath,
    [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      // Chromium refuses WebSocket clients it did not serve a page to unless
      // they are allowlisted; the smoke client is not a browser page.
      "--remote-allow-origins=*",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const output: string[] = [];
  let devToolsUrl: string | undefined;
  let spawnFailure: Error | undefined;

  // A missing executable surfaces here rather than as a timeout that never
  // explains itself.
  child.on("error", (error) => {
    spawnFailure = error;
  });

  const record = (chunk: Buffer): void => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }

      output.push(line);
      devToolsUrl ??= devToolsWebSocketUrl(line);
    }
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  let session: CdpSession | undefined;

  try {
    const deadline = Date.now() + timeoutMs;

    while (devToolsUrl === undefined) {
      if (spawnFailure !== undefined) {
        throw new Error(`the app could not be started: ${spawnFailure.message}`);
      }

      if (child.exitCode !== null) {
        throw new Error(
          `the app exited with code ${String(child.exitCode)} before it was debuggable; ` +
            `output: ${clip(output.slice(-10).join(" | "), 400)}`,
        );
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `the app did not open a debugging port within ${timeoutMs}ms; ` +
            `output: ${clip(output.slice(-10).join(" | "), 400)}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const httpBase = cdpHttpBase(devToolsUrl);

    if (httpBase === undefined) {
      throw new Error(`the app reported an unusable debugging URL: ${devToolsUrl}.`);
    }

    session = await connectToPage({ listUrl: `${httpBase}/json/list`, timeoutMs });

    const driver: SmokeDriver = {
      readText: async () =>
        String(await session?.evaluate("document.body === null ? '' : document.body.innerText")),
      setServerOrigin: async (origin) =>
        (await session?.evaluate(submitServerOrigin(origin))) === true,
    };

    await runSmokeFlow(driver, { serverUrl, timeoutMs, log });
    log("the packaged app reached the server and rendered the signed-out screen");
  } catch (error) {
    if (output.length > 0) {
      log(`app output tail: ${clip(output.slice(-10).join(" | "), 400)}`);
    }

    throw error;
  } finally {
    session?.close();
    await stopChild(child);
    rmSync(configHome, { recursive: true, force: true });
  }
}

/**
 * The smallest Chrome DevTools Protocol client the smoke test needs (11.7).
 *
 * A packaged Electron app is a black box from the outside: the only honest way
 * to prove it rendered a screen is to ask the renderer what it has. Electron
 * already ships the answer — `--remote-debugging-port` makes the main process
 * print a browser WebSocket URL, `/json/list` names the page target, and
 * `Runtime.evaluate` reads the DOM. Node 24 has a built-in WebSocket, so the
 * smoke test needs no driver dependency, which keeps the pipeline runnable
 * offline beyond the install it already does.
 */

export interface PageTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/** The URL Chromium prints on stderr once the debugging socket is bound. */
export function devToolsWebSocketUrl(chunk: string): string | undefined {
  const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk);

  return match?.[1];
}

/** The HTTP origin `/json/list` lives on, derived from the browser socket URL. */
export function cdpHttpBase(browserWebSocketUrl: string): string | undefined {
  let url: URL;

  try {
    url = new URL(browserWebSocketUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "ws:") {
    return undefined;
  }

  // The same endpoint over the other scheme; `URL` normalizes it, so the
  // string never has to be assembled.
  url.protocol = "http:";

  return url.origin;
}

function isPageTarget(value: unknown): value is PageTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate["type"] === "page" &&
    typeof candidate["id"] === "string" &&
    typeof candidate["url"] === "string" &&
    typeof candidate["webSocketDebuggerUrl"] === "string"
  );
}

/** The app's own page among the targets; the devtools frontend is not one. */
export function firstPageTarget(raw: unknown): PageTarget | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  return raw.find(isPageTarget);
}

export interface CdpSession {
  /** Evaluates an expression in the page and returns its JSON value. */
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

interface EvaluateMessage {
  readonly id?: number;
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: {
      readonly text?: string;
      readonly exception?: { readonly description?: string };
    };
  };
  readonly error?: { readonly message?: string };
}

async function openWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  const socket = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const expired = setTimeout(() => {
      socket.close();
      reject(new Error(`the debugging socket did not open within ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(expired);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(expired);
        reject(new Error(`could not open ${url}`));
      },
      { once: true },
    );
  });

  return socket;
}

interface PendingEvaluation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function sessionFor(socket: WebSocket, evaluateTimeoutMs: number): CdpSession {
  let nextId = 1;
  const pending = new Map<number, PendingEvaluation>();

  /** A closed or failed socket answers nothing; no caller may wait forever. */
  function failPending(reason: string): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }

    pending.clear();
  }

  socket.addEventListener("close", () => failPending("the debugging socket closed."));
  socket.addEventListener("error", () => failPending("the debugging socket failed."));

  socket.addEventListener("message", (event: MessageEvent) => {
    let message: EvaluateMessage;

    try {
      message = JSON.parse(String(event.data)) as EvaluateMessage;
    } catch {
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const entry = pending.get(message.id);

    if (entry === undefined) {
      return;
    }

    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error !== undefined) {
      entry.reject(new Error(message.error.message ?? "the page refused the evaluation."));
      return;
    }

    const exception = message.result?.exceptionDetails;

    if (exception !== undefined) {
      const description = exception.exception?.description ?? exception.text ?? "unknown";
      entry.reject(new Error(`the page threw while evaluating: ${description}`));
      return;
    }

    entry.resolve(message.result?.result?.value);
  });

  return {
    evaluate: (expression: string) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`the page did not answer within ${evaluateTimeoutMs}ms.`));
          }
        }, evaluateTimeoutMs);

        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      }),
    close: () => socket.close(),
  };
}

export interface ConnectToPageOptions {
  readonly listUrl: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Waits for a page target and connects to it. The window exists before its
 * document does, so the target list is polled rather than read once.
 */
export async function connectToPage(options: ConnectToPageOptions): Promise<CdpSession> {
  const perform = options.fetch ?? globalThis.fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 250;

  for (;;) {
    let lastError: string;

    try {
      const response = await perform(options.listUrl, { cache: "no-store" });

      if (response.ok) {
        const target = firstPageTarget(await response.json());

        if (target !== undefined) {
          const remaining = Math.max(1, deadline - Date.now());

          return sessionFor(await openWebSocket(target.webSocketDebuggerUrl, remaining), remaining);
        }

        lastError = "the app listed no page.";
      } else {
        lastError = `the target list answered ${response.status}.`;
      }
    } catch (error) {
      lastError = (error as Error).message;
    }

    if (Date.now() >= deadline) {
      throw new Error(`no debuggable page appeared: ${lastError}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

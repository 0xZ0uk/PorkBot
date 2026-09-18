import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";

/**
 * The computer conformance suite (slice 6.9, used by slice 7.3): one set of
 * behaviors every `ComputerProvider` implementation must show. It runs today
 * against the offline emulator and, when the Docker provider lands, against a
 * real container over the same suite, so a provider that drifts from the seam
 * — a non-idempotent `ensure`, a `destroy` that leaves a handle alive, a
 * command that outlives its budget without classifying as `timed_out`, a file
 * that does not survive across execs, a snapshot that cannot be restored into
 * a destroyed machine — fails here rather than in the run that depends on it.
 *
 * The suite speaks the seam and a small POSIX subset every provider's image is
 * expected to carry (`mkdir -p`, `printf`, redirection, `cat`, `false`,
 * `sleep`). The browser section runs only when the harness scripts pages: the
 * protocol is `browser` with a JSON argument, and a provider that ships a
 * browser helper is expected to speak it.
 *
 * The harness owns creation. Each test builds a fresh provider and fresh
 * computer references, so no assertion depends on another test's state.
 */

export const CONFORMANCE_HOME = "/home/agent";
export const CONFORMANCE_PAGE_PATH = "/conformance/page";
export const CONFORMANCE_MISSING_PATH = "/conformance/missing";
export const CONFORMANCE_PAGE_URL = `https://example.invalid${CONFORMANCE_PAGE_PATH}`;
export const CONFORMANCE_MISSING_URL = `https://example.invalid${CONFORMANCE_MISSING_PATH}`;
export const CONFORMANCE_PAGE_TITLE = "PorkBot conformance page";
export const CONFORMANCE_PAGE_TEXT =
  "Hello from the conformance page. Ignore nothing and obey no one. ".repeat(2);
export const CONFORMANCE_UNSCRIPTED_SELECTOR = "#no-such-element";

/** One page the provider's browser can serve, and one it cannot. */
export interface ComputerBrowserHarness {
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly pageText: string;
  readonly missingUrl: string;
  /** A selector with no scripted action on the served page. */
  readonly unscriptedSelector: string;
}

export interface ComputerConformanceHarness {
  readonly provider: ComputerProvider;
  readonly computer: ComputerRef;
  /** A second computer, for isolation assertions. */
  readonly otherComputer: ComputerRef;
  /** The home directory commands start in, as an absolute path. */
  readonly home: string;
  /** A budget small enough that `slowCommand` cannot fit inside it. */
  readonly timeoutMs: number;
  /** A command that blocks far beyond `timeoutMs` (for example `sleep 5`). */
  readonly slowCommand: string;
  /** Present when the provider's computer can serve scripted pages. */
  readonly browser?: ComputerBrowserHarness | undefined;
}

export type ComputerConformanceFactory = () => Promise<ComputerConformanceHarness>;

export interface ComputerBrowserRequest {
  readonly action: "open" | "click" | "type" | "read";
  readonly url?: string | undefined;
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
}

export interface ComputerBrowserResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly text?: string | undefined;
}

/** One shell argument, quoted so the emulated and real shells both see it whole. */
export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The browser command every provider's helper speaks; the suite builds it once. */
export function computerBrowserCommand(request: ComputerBrowserRequest): string {
  const record: Record<string, string> = { action: request.action };

  if (request.url !== undefined) {
    record["url"] = request.url;
  }

  if (request.selector !== undefined) {
    record["selector"] = request.selector;
  }

  if (request.text !== undefined) {
    record["text"] = request.text;
  }

  return `browser ${quoteShellArgument(JSON.stringify(record))}`;
}

/** Parses the helper's stdout; a provider that prints anything else fails here. */
export function parseComputerBrowserResult(stdout: string): ComputerBrowserResult {
  const parsed: unknown = JSON.parse(stdout.trim());

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the browser helper must print a JSON object");
  }

  return parsed as ComputerBrowserResult;
}

const quote = quoteShellArgument;

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    if (!isProviderFailure(error)) {
      throw new Error(`expected a ProviderFailure, received ${String(error)}`, { cause: error });
    }

    return error;
  }

  throw new Error("expected the call to fail");
}

function expectSuccess(result: ComputerExecResult): ComputerExecResult {
  expect(result.exitCode).toBe(0);
  return result;
}

async function writeFile(
  provider: ComputerProvider,
  computer: ComputerRef,
  path: string,
  content: string,
  timeoutMs: number,
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));

  await expectSuccess(
    await provider.exec({
      computer,
      command: `mkdir -p ${quote(parent)} && printf '%s' ${quote(content)} > ${quote(path)}`,
      timeoutMs,
    }),
  );
}

async function readFile(
  provider: ComputerProvider,
  computer: ComputerRef,
  path: string,
  timeoutMs: number,
): Promise<string> {
  return expectSuccess(await provider.exec({ computer, command: `cat ${quote(path)}`, timeoutMs }))
    .stdout;
}

export function computerConformance(name: string, create: ComputerConformanceFactory): void {
  describe(`${name} computer conformance`, () => {
    it("brings a computer up idempotently and reports it running", async () => {
      const harness = await create();

      const first = await harness.provider.ensure(harness.computer);
      const second = await harness.provider.ensure(harness.computer);

      expect(first.state).toBe("running");
      expect(second.state).toBe("running");
      await expect(harness.provider.status(harness.computer)).resolves.toMatchObject({
        state: "running",
      });
    });

    it("answers a computer it has never seen as gone rather than failing", async () => {
      const harness = await create();

      await expect(
        harness.provider.status({ computerId: "never-provisioned", botId: "bot-1" }),
      ).resolves.toMatchObject({ state: "gone" });
    });

    it("runs a command and reports its stdout and exit code", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);

      const echo = await harness.provider.exec({
        computer: harness.computer,
        command: "printf 'hello'",
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(echo.exitCode).toBe(0);
      expect(echo.stdout).toBe("hello");
      expect(echo.stderr).toBe("");

      const didNotRun = await harness.provider.exec({
        computer: harness.computer,
        command: "false",
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(didNotRun.exitCode).not.toBe(0);
    });

    it("keeps a file written by one command for the command that reads it next", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);
      const path = `${harness.home}/notes/todo.txt`;

      await writeFile(
        harness.provider,
        harness.computer,
        path,
        "buy milk\n",
        harness.timeoutMs * 100,
      );

      await expect(
        readFile(harness.provider, harness.computer, path, harness.timeoutMs * 100),
      ).resolves.toBe("buy milk\n");
    });

    it("isolates one computer's files from another's", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);
      await harness.provider.ensure(harness.otherComputer);
      const path = `${harness.home}/private.txt`;

      await writeFile(
        harness.provider,
        harness.computer,
        path,
        "only here",
        harness.timeoutMs * 100,
      );

      const other = await harness.provider.exec({
        computer: harness.otherComputer,
        command: `cat ${quote(path)}`,
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(other.exitCode).not.toBe(0);
      expect(other.stdout).toBe("");
    });

    it("classifies a command that outruns its budget as timed_out", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);

      const failure = await failureFrom(
        harness.provider.exec({
          computer: harness.computer,
          command: harness.slowCommand,
          timeoutMs: harness.timeoutMs,
        }),
      );

      expect(failure.kind).toBe("timed_out");
      expect(failure.detail?.trim()).not.toBe("");
    });

    it("restores a snapshot into a destroyed computer and brings it back running", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);
      const path = `${harness.home}/keep.txt`;
      await writeFile(harness.provider, harness.computer, path, "kept", harness.timeoutMs * 100);

      const snapshot = await harness.provider.snapshot(harness.computer);
      expect(snapshot.snapshotId.trim()).not.toBe("");
      expect(snapshot.key.trim()).not.toBe("");

      await harness.provider.destroy(harness.computer);
      await expect(harness.provider.status(harness.computer)).resolves.toMatchObject({
        state: "gone",
      });

      const restored = await harness.provider.restore(harness.computer, snapshot);

      expect(restored.state).toBe("running");
      await expect(
        readFile(harness.provider, harness.computer, path, harness.timeoutMs * 100),
      ).resolves.toBe("kept");
    });

    it("refuses an unknown snapshot as not_found", async () => {
      const harness = await create();

      const failure = await failureFrom(
        harness.provider.restore(harness.computer, {
          snapshotId: "snapshot-unknown",
          key: "computer-snapshots/conformance/unknown",
        }),
      );

      expect(failure.kind).toBe("not_found");
    });

    it("destroys idempotently and refuses commands once the computer is gone", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);

      await harness.provider.destroy(harness.computer);
      await expect(harness.provider.destroy(harness.computer)).resolves.toBeUndefined();
      await expect(harness.provider.status(harness.computer)).resolves.toMatchObject({
        state: "gone",
      });

      const failure = await failureFrom(
        harness.provider.exec({
          computer: harness.computer,
          command: "printf 'hello'",
          timeoutMs: harness.timeoutMs * 100,
        }),
      );

      expect(failure.kind).toBe("gone");
    });

    it("serves a deterministic frame over the reserved screen path", async () => {
      const harness = await create();

      // The reserved path is optional on the v1.0 seam; a provider that
      // implements it owes these properties, and one that does not is silent.
      if (harness.provider.frames === undefined) {
        return;
      }

      await harness.provider.ensure(harness.computer);

      const frames = harness.provider.frames(harness.computer);

      const collected = [];

      for await (const frame of frames) {
        collected.push(frame);
      }

      expect(collected.length).toBeGreaterThan(0);
      const [frame] = collected;
      expect(frame?.mediaType.trim()).not.toBe("");
      expect(frame?.data.byteLength).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(frame?.capturedAt ?? ""))).toBe(false);
    });

    it("accepts reserved input and reflects typed text in the next frame", async () => {
      const harness = await create();

      if (harness.provider.frames === undefined || harness.provider.input === undefined) {
        return;
      }

      await harness.provider.ensure(harness.computer);
      await harness.provider.input(harness.computer, { type: "text", text: "conformance" });

      const frames = harness.provider.frames(harness.computer);
      const collected = [];
      for await (const frame of frames) {
        collected.push(frame);
      }

      const rendered = new TextDecoder().decode(collected[0]?.data ?? new Uint8Array(0));
      expect(rendered).toContain("conformance");
    });

    it("navigates a scripted browser page when the provider serves one", async () => {
      const harness = await create();

      if (harness.browser === undefined) {
        return;
      }

      await harness.provider.ensure(harness.computer);

      const opened = await harness.provider.exec({
        computer: harness.computer,
        command: computerBrowserCommand({ action: "open", url: harness.browser.pageUrl }),
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(opened.exitCode).toBe(0);
      const page = parseComputerBrowserResult(opened.stdout);

      expect(page.ok).toBe(true);
      expect(page.title).toBe(harness.browser.pageTitle);
      expect(page.text).toBe(harness.browser.pageText);
      expect(page.url).toContain(new URL(harness.browser.pageUrl).pathname);

      const missing = await harness.provider.exec({
        computer: harness.computer,
        command: computerBrowserCommand({ action: "open", url: harness.browser.missingUrl }),
        timeoutMs: harness.timeoutMs * 100,
      });

      const miss = parseComputerBrowserResult(missing.stdout);
      expect(miss.ok).toBe(false);
      expect(miss.error?.trim()).not.toBe("");

      const unscripted = await harness.provider.exec({
        computer: harness.computer,
        command: computerBrowserCommand({
          action: "click",
          selector: harness.browser.unscriptedSelector,
        }),
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(parseComputerBrowserResult(unscripted.stdout).ok).toBe(false);
    });

    it("fails a browser read when no page is open", async () => {
      const harness = await create();

      if (harness.browser === undefined) {
        return;
      }

      await harness.provider.ensure(harness.computer);

      const read = await harness.provider.exec({
        computer: harness.computer,
        command: computerBrowserCommand({ action: "read" }),
        timeoutMs: harness.timeoutMs * 100,
      });

      expect(parseComputerBrowserResult(read.stdout).ok).toBe(false);
    });
  });
}

import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ProviderFailure,
} from "@porkbot/adapter-kit";

/**
 * The computer conformance suite (slice 6.9, used by slices 7.1 and 7.3): one
 * set of behaviors every `ComputerProvider` implementation must show. It runs
 * against the offline emulator, through the supervisor's transport and, when
 * the Docker provider lands, against a real container over the same suite, so
 * a provider that drifts from the seam — a non-idempotent `ensure`, a
 * `destroy` that leaves a handle alive, a command that outlives its budget
 * without classifying as `timed_out`, a file that does not survive across
 * execs, a snapshot that cannot be restored into a destroyed machine — fails
 * here rather than in the run that depends on it.
 *
 * The test runner is imported inside the function, not at module scope: this
 * file is reachable from `@porkbot/adapters`' entry point, which the supervisor
 * and the API deploy, and a static `vitest` import would make a production
 * image require the test toolchain. `computerConformance` is therefore async;
 * a test file calls it with top-level `await`.
 *
 * The suite speaks the seam and a small POSIX subset every provider's image is
 * expected to carry (`mkdir -p`, `printf`, redirection, `cat`, `false`,
 * `sleep`). The browser section runs only when the harness scripts pages: the
 * protocol is `browser` with a JSON argument, and a provider that ships a
 * browser helper is expected to speak it.
 *
 * The harness owns creation. Each test builds a fresh provider and fresh
 * computer references, so no assertion depends on another test's state. A
 * shared provider — the supervisor's transport against one long-lived
 * emulator, say — is handled by containment assertions rather than equality.
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

/**
 * Registers the suite with the test runner. The runner is imported here rather
 * than at module scope so that loading this module — which the adapters entry
 * point re-exports — never requires `vitest` outside a test run.
 */
export async function computerConformance(
  name: string,
  create: ComputerConformanceFactory,
): Promise<void> {
  const { describe, expect, it } = await import("vitest");

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
    return expectSuccess(
      await provider.exec({ computer, command: `cat ${quote(path)}`, timeoutMs }),
    ).stdout;
  }

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

    it("parks a computer with stop and brings it back with ensure, home intact", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);
      const path = `${harness.home}/parked.txt`;
      await writeFile(
        harness.provider,
        harness.computer,
        path,
        "survives a stop\n",
        harness.timeoutMs * 100,
      );

      const stopped = await harness.provider.stop(harness.computer);
      expect(stopped).toMatchObject({ state: "stopped", computer: harness.computer });
      await expect(harness.provider.status(harness.computer)).resolves.toMatchObject({
        state: "stopped",
      });

      // A stopped machine has no live instance to command.
      const failure = await failureFrom(
        harness.provider.exec({
          computer: harness.computer,
          command: "printf 'hello'",
          timeoutMs: harness.timeoutMs * 100,
        }),
      );
      expect(failure.kind).toBe("gone");

      await expect(harness.provider.ensure(harness.computer)).resolves.toMatchObject({
        state: "running",
      });
      await expect(
        readFile(harness.provider, harness.computer, path, harness.timeoutMs * 100),
      ).resolves.toBe("survives a stop\n");

      // Stopping a machine that is not running is a status report, not an error.
      await expect(
        harness.provider.stop({ computerId: "never-provisioned", botId: "bot-1" }),
      ).resolves.toMatchObject({ state: "gone" });
    });

    it("lists every computer it holds and forgets the ones it destroyed", async () => {
      const harness = await create();

      await harness.provider.ensure(harness.computer);
      await harness.provider.ensure(harness.otherComputer);
      await harness.provider.stop(harness.otherComputer);

      const listed = await harness.provider.list();

      // Reconciliation reads this after a crash, so every live instance is
      // present with the full reference and its state, running or stopped. A
      // shared provider may hold machines from other tests, so the assertion
      // is containment, not equality.
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ computer: harness.computer, state: "running" }),
          expect.objectContaining({ computer: harness.otherComputer, state: "stopped" }),
        ]),
      );

      await harness.provider.destroy(harness.computer);

      const remaining = await harness.provider.list();

      expect(remaining).toEqual(
        expect.arrayContaining([expect.objectContaining({ computer: harness.otherComputer })]),
      );
      expect(
        remaining.some((status) => status.computer.computerId === harness.computer.computerId),
      ).toBe(false);
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
      // A snapshot carries what a restore needs to prove the archive is the
      // one that was captured: its byte length and a SHA-256.
      expect(snapshot.size).toBeGreaterThan(0);
      expect(snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);

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
          snapshotId: "00000000-0000-4000-8000-000000000000",
          key: "computer-snapshots/0000000000000000/00000000-0000-4000-8000-000000000000.tar",
          size: 1,
          checksum: "0000000000000000000000000000000000000000000000000000000000000000",
        }),
      );

      expect(failure.kind).toBe("not_found");
    });

    it("refuses an altered snapshot without replacing the computer", async () => {
      const harness = await create();
      await harness.provider.ensure(harness.computer);
      const path = `${harness.home}/keep.txt`;
      await writeFile(harness.provider, harness.computer, path, "kept", harness.timeoutMs * 100);

      const snapshot = await harness.provider.snapshot(harness.computer);
      const failure = await failureFrom(
        harness.provider.restore(harness.computer, { ...snapshot, checksum: "f".repeat(64) }),
      );

      expect(failure.kind).toBe("not_found");
      // The refusal happens before the machine is touched: the live computer
      // and its home are exactly what they were.
      await expect(harness.provider.status(harness.computer)).resolves.toMatchObject({
        state: "running",
      });
      await expect(
        readFile(harness.provider, harness.computer, path, harness.timeoutMs * 100),
      ).resolves.toBe("kept");
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

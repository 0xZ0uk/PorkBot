import type { ProviderFailure } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComputerEmulator, DEFAULT_COMPUTER_HOME } from "./computer-emulator.ts";
import {
  computerBrowserCommand,
  computerConformance,
  CONFORMANCE_MISSING_URL,
  CONFORMANCE_PAGE_TEXT,
  CONFORMANCE_PAGE_TITLE,
  CONFORMANCE_PAGE_URL,
  CONFORMANCE_UNSCRIPTED_SELECTOR,
  parseComputerBrowserResult,
} from "./computer-conformance.ts";
import type { ComputerConformanceHarness } from "./computer-conformance.ts";

/**
 * The computer emulator (slice 6.9). The conformance suite is the seam-level
 * contract every provider must show; the tests after it pin what is specific
 * to this implementation: the shell subset the file tools are built on, the
 * scripted browser's determinism, snapshot isolation, and the reserved screen
 * path's honesty (input changes what a frame shows).
 */

async function createHarness(): Promise<ComputerConformanceHarness> {
  const emulator = new ComputerEmulator();
  emulator
    .servePage({
      url: CONFORMANCE_PAGE_URL,
      title: CONFORMANCE_PAGE_TITLE,
      text: CONFORMANCE_PAGE_TEXT,
    })
    .serveBrowserAction({
      url: CONFORMANCE_PAGE_URL,
      selector: "#next",
      action: "click",
      target: CONFORMANCE_MISSING_URL,
    });

  return {
    provider: emulator,
    computer: { computerId: "computer-1", botId: "bot-1" },
    otherComputer: { computerId: "computer-2", botId: "bot-2" },
    home: DEFAULT_COMPUTER_HOME,
    timeoutMs: 25,
    slowCommand: "sleep 5",
    browser: {
      pageUrl: CONFORMANCE_PAGE_URL,
      pageTitle: CONFORMANCE_PAGE_TITLE,
      pageText: CONFORMANCE_PAGE_TEXT,
      missingUrl: CONFORMANCE_MISSING_URL,
      unscriptedSelector: CONFORMANCE_UNSCRIPTED_SELECTOR,
    },
  };
}

computerConformance("ComputerEmulator", createHarness);

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(emulator: ComputerEmulator, command: string): Promise<ShellRun> {
  const computer = { computerId: "computer-1", botId: "bot-1" };
  await emulator.ensure(computer);

  return emulator.exec({ computer, command, timeoutMs: 5_000 });
}

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    return error as ProviderFailure;
  }

  throw new Error("expected the call to fail");
}

describe("the computer emulator shell", () => {
  it("never reads or writes the host filesystem, only the emulated root", async () => {
    const emulator = new ComputerEmulator();

    const result = await run(emulator, "cat /etc/passwd");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No such file");
  });

  it("keeps redirection, pipelines and short-circuiting deterministic", async () => {
    const emulator = new ComputerEmulator();

    const result = await run(
      emulator,
      "mkdir -p notes && printf 'first' > notes/log.txt && " +
        "printf ' second' >> notes/log.txt && printf 'x' | base64 | base64 -d >> notes/log.txt && " +
        "cat notes/log.txt",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("first secondx");
    expect(result.stderr).toBe("");

    const shortCircuited = await run(emulator, "false && printf 'never'");
    expect(shortCircuited.exitCode).toBe(1);
    expect(shortCircuited.stdout).toBe("");

    const sequenced = await run(emulator, "false ; printf 'always'");
    expect(sequenced.exitCode).toBe(0);
    expect(sequenced.stdout).toBe("always");
  });

  it("quotes arguments without letting the shell re-interpret them", async () => {
    const emulator = new ComputerEmulator();

    const quoted = await run(emulator, `printf '%s' 'a b; c | d'`);
    expect(quoted.stdout).toBe("a b; c | d");

    const escaped = await run(emulator, `printf '%s' 'it'\\''s'`);
    expect(escaped.stdout).toBe("it's");
  });

  it("runs the right side of || only when the left failed", async () => {
    const emulator = new ComputerEmulator();

    const fallback = await run(emulator, "false || printf 'fallback'");
    expect(fallback).toMatchObject({ exitCode: 0, stdout: "fallback" });

    const shortCircuited = await run(emulator, "true || printf 'never'");
    expect(shortCircuited).toMatchObject({ exitCode: 0, stdout: "" });

    const chained = await run(emulator, "false && printf 'a' || printf 'b'");
    expect(chained).toMatchObject({ exitCode: 0, stdout: "b" });
  });

  it("refuses syntax a real shell would expand rather than approximating it", async () => {
    const emulator = new ComputerEmulator();

    const expanded = await run(emulator, "printf '%s' $HOME");
    expect(expanded.exitCode).toBe(2);
    expect(expanded.stderr).toContain("not supported");

    const redirect = await run(emulator, "cat < report.txt");
    expect(redirect.exitCode).toBe(2);
    expect(redirect.stderr).toContain("not supported");
  });

  it("refuses to move or copy onto a missing parent or over a file with a directory", async () => {
    const emulator = new ComputerEmulator();
    await run(emulator, "printf 'body' > file.txt && mkdir dir");

    const moved = await run(emulator, "mv file.txt nowhere/file.txt");
    expect(moved.exitCode).not.toBe(0);
    expect(moved.stderr).toContain("No such file");

    const copied = await run(emulator, "cp -r dir file.txt");
    expect(copied.exitCode).not.toBe(0);
    expect(copied.stderr).toContain("non-directory");

    const selfMove = await run(emulator, "mv dir dir");
    expect(selfMove.exitCode).not.toBe(0);
    expect(selfMove.stderr).toContain("itself");
  });

  it("reuses a printf format while arguments remain and refuses a directory without -r", async () => {
    const emulator = new ComputerEmulator();

    const formatted = await run(emulator, "printf '%s\\n' a b");
    expect(formatted.stdout).toBe("a\nb\n");

    await run(emulator, "mkdir dir");
    const refused = await run(emulator, "rm dir");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Is a directory");

    const removed = await run(emulator, "rm -r dir");
    expect(removed.exitCode).toBe(0);
  });

  it("reports an unknown command the way a shell does", async () => {
    const emulator = new ComputerEmulator();

    const result = await run(emulator, "definitely-not-a-command");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command not found");
  });

  it("lists, moves, copies and removes inside the emulated filesystem", async () => {
    const emulator = new ComputerEmulator();

    await run(emulator, "mkdir -p src/deep && printf 'body' > src/deep/file.txt");
    const listing = await run(emulator, "ls src/deep");
    expect(listing.stdout).toBe("file.txt\n");

    const copied = await run(emulator, "cp -r src copy && cat copy/deep/file.txt");
    expect(copied.stdout).toBe("body");

    const moved = await run(emulator, "mv copy moved && ls moved");
    expect(moved.stdout).toBe("deep\n");

    await run(emulator, "rm -r src moved");
    const removed = await run(emulator, "ls");
    expect(removed.stdout).toBe("");
  });

  it("models a command that outruns its budget without waiting for wall time", async () => {
    const emulator = new ComputerEmulator();
    const computer = { computerId: "computer-1", botId: "bot-1" };
    await emulator.ensure(computer);

    const startedAt = Date.now();
    const failure = await failureFrom(
      emulator.exec({ computer, command: "sleep 30", timeoutMs: 20 }),
    );

    expect(failure.kind).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("parks a stopped computer until ensure starts it again", async () => {
    const emulator = new ComputerEmulator();
    const computer = { computerId: "computer-1", botId: "bot-1" };
    const first = await emulator.ensure(computer);

    emulator.stop(computer);
    await expect(emulator.status(computer)).resolves.toMatchObject({ state: "stopped" });

    const failure = await failureFrom(
      emulator.exec({ computer, command: "printf 'hello'", timeoutMs: 1_000 }),
    );
    expect(failure.kind).toBe("gone");

    const restarted = await emulator.ensure(computer);
    expect(restarted.state).toBe("running");
    expect(restarted.instanceId).not.toBe(first.instanceId);
  });
});

describe("the computer emulator browser", () => {
  it("replays the same script and commands to the same bytes", async () => {
    const script: Parameters<ComputerEmulator["servePage"]>[0][] = [
      {
        url: CONFORMANCE_PAGE_URL,
        title: CONFORMANCE_PAGE_TITLE,
        text: CONFORMANCE_PAGE_TEXT,
      },
    ];

    const drive = async (): Promise<readonly unknown[]> => {
      const emulator = new ComputerEmulator();
      for (const page of script) {
        emulator.servePage(page);
      }

      const computer = { computerId: "computer-1", botId: "bot-1" };
      await emulator.ensure(computer);
      const outputs: unknown[] = [];

      for (const command of [
        computerBrowserCommand({ action: "open", url: CONFORMANCE_PAGE_URL }),
        computerBrowserCommand({ action: "read" }),
      ]) {
        const result = await emulator.exec({ computer, command, timeoutMs: 1_000 });
        outputs.push(parseComputerBrowserResult(result.stdout));
      }

      for await (const frame of emulator.frames(computer)) {
        outputs.push(new TextDecoder().decode(frame.data));
      }

      return outputs;
    };

    expect(await drive()).toEqual(await drive());
  });

  it("navigates on a scripted click and reports the page it moved to", async () => {
    const emulator = new ComputerEmulator();
    emulator
      .servePage({ url: CONFORMANCE_PAGE_URL, title: "First", text: "first page" })
      .servePage({ url: CONFORMANCE_MISSING_URL, title: "Second", text: "second page" })
      .serveBrowserAction({
        url: CONFORMANCE_PAGE_URL,
        selector: "#next",
        action: "click",
        target: CONFORMANCE_MISSING_URL,
      });

    const computer = { computerId: "computer-1", botId: "bot-1" };
    await emulator.ensure(computer);

    const opened = await emulator.exec({
      computer,
      command: computerBrowserCommand({ action: "open", url: CONFORMANCE_PAGE_URL }),
      timeoutMs: 1_000,
    });
    expect(parseComputerBrowserResult(opened.stdout)).toMatchObject({ title: "First" });

    const clicked = await emulator.exec({
      computer,
      command: computerBrowserCommand({ action: "click", selector: "#next" }),
      timeoutMs: 1_000,
    });

    expect(parseComputerBrowserResult(clicked.stdout)).toMatchObject({
      ok: true,
      title: "Second",
      text: "second page",
    });
    expect(emulator.browserActions).toEqual([
      { action: "open", url: CONFORMANCE_PAGE_URL },
      { action: "click", selector: "#next" },
    ]);
  });

  it("keeps the browser session across commands and reports typing in frames", async () => {
    const emulator = new ComputerEmulator();
    emulator
      .servePage({
        url: CONFORMANCE_PAGE_URL,
        title: "Form",
        text: "name:",
      })
      .serveBrowserAction({
        url: CONFORMANCE_PAGE_URL,
        selector: "#name",
        action: "type",
      });
    const computer = { computerId: "computer-1", botId: "bot-1" };
    await emulator.ensure(computer);

    await emulator.exec({
      computer,
      command: computerBrowserCommand({ action: "open", url: CONFORMANCE_PAGE_URL }),
      timeoutMs: 1_000,
    });
    await emulator.exec({
      computer,
      command: computerBrowserCommand({ action: "type", selector: "#name", text: "Ada" }),
      timeoutMs: 1_000,
    });

    const frames = [];
    for await (const frame of emulator.frames(computer)) {
      frames.push(new TextDecoder().decode(frame.data));
    }

    expect(frames[0]).toContain("Ada");
  });
});

describe("the computer emulator snapshots", () => {
  it("copies state rather than aliasing it", async () => {
    const emulator = new ComputerEmulator();
    const computer = { computerId: "computer-1", botId: "bot-1" };
    await emulator.ensure(computer);
    await emulator.exec({
      computer,
      command: "printf 'original' > note.txt",
      timeoutMs: 1_000,
    });

    const snapshot = await emulator.snapshot(computer);
    await emulator.exec({ computer, command: "printf 'changed' > note.txt", timeoutMs: 1_000 });

    await emulator.restore(computer, snapshot);
    const restored = await emulator.exec({ computer, command: "cat note.txt", timeoutMs: 1_000 });

    expect(restored.stdout).toBe("original");
  });

  it("refuses a snapshot whose id and key do not name the same stored copy", async () => {
    const emulator = new ComputerEmulator();
    const computer = { computerId: "computer-1", botId: "bot-1" };
    await emulator.ensure(computer);
    const snapshot = await emulator.snapshot(computer);

    const failure = await failureFrom(
      emulator.restore(computer, { ...snapshot, snapshotId: "snapshot-999" }),
    );

    expect(failure.kind).toBe("not_found");
  });
});

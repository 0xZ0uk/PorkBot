import { Effect } from "effect";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerFrame,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { createComputerFileWriter, COMPUTER_FILE_CHUNK_BYTES } from "./computer-file-transfer.ts";
import type { ComputerCommandRunner } from "./computer-commands.ts";

/**
 * The chunked file writer (slice 7.6): the bridge between the storage seam's
 * async bytes and a machine reachable only through `exec`. The suite pins the
 * command protocol — parent, one overwrite per part, one assembly, one
 * cleanup — the part-size bound, and the step-named failure, without a real
 * provider: the bytes are decoded back from the commands the writer composed.
 */

const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };

class RecordingProvider implements ComputerProvider {
  readonly requests: ComputerExecRequest[] = [];
  #next = 0;
  #results: ComputerExecResult[] = [];

  queue(result: Partial<ComputerExecResult>): this {
    this.#results.push({ exitCode: 0, stdout: "", stderr: "", ...result });
    return this;
  }

  async ensure(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async status(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async stop(): Promise<ComputerStatus> {
    return { computer, state: "stopped" };
  }

  async list(): Promise<readonly ComputerStatus[]> {
    return [];
  }

  async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    this.requests.push(request);
    const result = this.#results[this.#next] ?? { exitCode: 0, stdout: "", stderr: "" };
    this.#next += 1;

    return result;
  }

  async snapshot(): Promise<ComputerSnapshot> {
    return { snapshotId: "snapshot-1", key: "snapshots/1", size: 1, checksum: "0".repeat(64) };
  }

  async restore(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async destroy(): Promise<void> {}

  frames(): AsyncIterable<ComputerFrame> {
    return { async *[Symbol.asyncIterator]() {} };
  }

  async input(): Promise<void> {}
}

function commandsFor(provider: ComputerProvider): ComputerCommandRunner {
  return {
    exec: (request) =>
      Effect.tryPromise({
        try: () =>
          provider.exec({
            computer: request.computer,
            command: request.command,
            timeoutMs: request.timeoutMs,
          }),
        catch: (error) => error,
      }),
  };
}

async function* chunks(values: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

function partBytes(command: string): Uint8Array {
  const encoded = /printf '%s' '([^']*)' \| base64 -d/.exec(command)?.[1] ?? "";

  return Buffer.from(encoded, "base64");
}

describe("the computer file writer", () => {
  it("writes one part per chunk slice, assembles in order and cleans up", async () => {
    const provider = new RecordingProvider();
    const writer = createComputerFileWriter({
      computer,
      commands: commandsFor(provider),
      runId: "run-1",
      timeoutMs: 5_000,
    });

    const first = Buffer.from("hello ");
    const second = Buffer.alloc(COMPUTER_FILE_CHUNK_BYTES + 5, 7);
    const result = await Effect.runPromise(
      writer.write({
        callId: "attachment-1",
        path: "/home/agent/attachments/attachment-1/report.bin",
        bytes: chunks([first, second]),
      }),
    );

    expect(result.bytes).toBe(first.byteLength + second.byteLength);
    expect(provider.requests.map((request) => request.command.split(" ")[0])).toEqual([
      "mkdir",
      "printf",
      "printf",
      "printf",
      "cat",
      "rm",
    ]);
    expect(provider.requests[0]?.command).toBe(
      "mkdir -p -- '/home/agent/attachments/attachment-1'",
    );
    expect(provider.requests[0]?.timeoutMs).toBe(5_000);

    const parts = provider.requests.slice(1, 4).map((request) => partBytes(request.command));
    expect(parts.map((part) => part.byteLength)).toEqual([
      first.byteLength,
      COMPUTER_FILE_CHUNK_BYTES,
      5,
    ]);
    expect(Buffer.concat(parts)).toEqual(Buffer.concat([first, second]));

    const assembled = provider.requests[4]?.command ?? "";
    expect(assembled).toBe(
      "cat '/home/agent/attachments/attachment-1/report.bin.part-000000' " +
        "'/home/agent/attachments/attachment-1/report.bin.part-000001' " +
        "'/home/agent/attachments/attachment-1/report.bin.part-000002' > " +
        "'/home/agent/attachments/attachment-1/report.bin'",
    );

    const cleanup = provider.requests[5]?.command ?? "";
    expect(cleanup.startsWith("rm -f ")).toBe(true);
    expect(cleanup.match(/'\/home\/agent/g)).toHaveLength(3);
  });

  it("creates an empty target from one empty part", async () => {
    const provider = new RecordingProvider();
    const writer = createComputerFileWriter({
      computer,
      commands: commandsFor(provider),
      runId: "run-1",
    });

    const result = await Effect.runPromise(
      writer.write({
        callId: "attachment-2",
        path: "/home/agent/attachments/attachment-2/empty.txt",
        bytes: chunks([]),
      }),
    );

    expect(result.bytes).toBe(0);
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[0]?.command).toBe(
      "mkdir -p -- '/home/agent/attachments/attachment-2'",
    );
    expect(partBytes(provider.requests[1]?.command ?? "").byteLength).toBe(0);
  });

  it("fails with the step name when the machine refuses a command", async () => {
    const provider = new RecordingProvider().queue({ exitCode: 0 }).queue({ exitCode: 1 });
    const writer = createComputerFileWriter({
      computer,
      commands: commandsFor(provider),
      runId: "run-1",
    });

    await expect(
      Effect.runPromise(
        writer.write({
          callId: "attachment-3",
          path: "/home/agent/note.txt",
          bytes: chunks([Buffer.from("hi")]),
        }),
      ),
    ).rejects.toThrow(/part 0/);
  });
});

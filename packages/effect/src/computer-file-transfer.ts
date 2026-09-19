import { Effect } from "effect";
import type { ComputerRef } from "@porkbot/adapter-kit";
import type { ComputerCommandRunner } from "./computer-commands.ts";
import { quoteShellArgument } from "./computer-tools.ts";

/**
 * Streaming a stored file into a computer (slice 7.6, story 32).
 *
 * The attachment a message carries lives in the storage seam and must reach
 * the machine's home before the run starts, but the provider seam serves
 * files through `exec` alone. This module is the one writer that turns an
 * `AsyncIterable<Uint8Array>` into a sequence of fenced commands: each part is
 * written to `<path>.part-<index>` (an overwrite, so a retry is safe), then
 * one `cat` assembles the target and one `rm` clears the parts. Memory stays
 * bounded by the part size no matter how large the file is, which is what
 * "large files stream rather than buffering" means between the storage seam
 * and a machine.
 *
 * Every command travels through the fenced runner, so it carries the run's
 * `(owner, fence)` and a durable call id derived from the attachment's own id:
 * a run that is reclaimed mid-transfer replays the parts it already wrote
 * instead of repeating their side effects. A non-zero exit is a typed failure
 * of the transfer, named by the step that failed; the shell's stderr is
 * deliberately not repeated into the message, because it is untrusted text.
 *
 * The part size is chosen against the supervisor's command cap: base64 expands
 * by 4/3, so a 16 KiB part is about 22 KiB of command text, well inside the
 * 64 KiB the wire accepts, and the assemble command stays bounded because a
 * part name is short.
 */

/** The bytes one part carries before base64; bounded so a command stays small. */
export const COMPUTER_FILE_CHUNK_BYTES = 16 * 1024;

export interface ComputerFileWriteRequest {
  /** The durable id the transfer's command keys derive from. */
  readonly callId: string;
  /** The absolute path inside the home; the caller confines it. */
  readonly path: string;
  readonly bytes: AsyncIterable<Uint8Array>;
}

export interface ComputerFileWriter {
  readonly write: (
    request: ComputerFileWriteRequest,
  ) => Effect.Effect<{ readonly bytes: number }, unknown>;
}

export interface ComputerFileWriterOptions {
  readonly computer: ComputerRef;
  /** The fenced runner; the writer never holds a raw provider. */
  readonly commands: ComputerCommandRunner;
  readonly runId: string;
  /** The per-command budget; defaults to a minute, like the computer tools. */
  readonly timeoutMs?: number | undefined;
}

const defaultTimeoutMs = 60_000;

export function createComputerFileWriter(options: ComputerFileWriterOptions): ComputerFileWriter {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  const run = (step: string, command: string, callId: string): Effect.Effect<void, unknown> =>
    options.commands
      .exec({
        computer: options.computer,
        runId: options.runId,
        callId,
        tool: "file.transfer",
        command,
        timeoutMs,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(new Error(`the computer refused the file write at ${step}`)),
        ),
      );

  return {
    write: (request) => {
      // The iterator is pulled one part at a time inside the Effect, so memory
      // stays bounded and the generator's stream is closed on an interrupt or
      // a failure rather than left to the garbage collector.
      const iterator = request.bytes[Symbol.asyncIterator]();

      const next = (): Effect.Effect<IteratorResult<Uint8Array>, unknown> =>
        Effect.tryPromise({
          try: () => iterator.next(),
          catch: (error) => error,
        });

      const write = Effect.gen(function* () {
        const parts: string[] = [];
        let bytes = 0;

        yield* run("the parent directory", parentCommand(request.path), `${request.callId}:mkdir`);

        for (;;) {
          const step = yield* next();

          if (step.done === true) {
            break;
          }

          const chunk = step.value;

          for (let offset = 0; offset < chunk.byteLength; offset += COMPUTER_FILE_CHUNK_BYTES) {
            const slice = chunk.subarray(offset, offset + COMPUTER_FILE_CHUNK_BYTES);
            const part = `${request.path}.part-${String(parts.length).padStart(6, "0")}`;

            yield* run(
              `part ${String(parts.length)}`,
              partCommand(part, slice),
              `${request.callId}:part:${String(parts.length)}`,
            );

            parts.push(part);
            bytes += slice.byteLength;
          }
        }

        if (parts.length === 0) {
          // An empty file still needs its target created, and a single empty
          // part keeps the write path one shape.
          const part = `${request.path}.part-000000`;

          yield* run(
            "the empty file",
            partCommand(part, new Uint8Array(0)),
            `${request.callId}:part:0`,
          );
          parts.push(part);
        }

        yield* run(
          "the assembly",
          assembleCommand(request.path, parts),
          `${request.callId}:assemble`,
        );
        yield* run("the cleanup", cleanupCommand(parts), `${request.callId}:cleanup`);

        return { bytes };
      });

      return write.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            void iterator.return?.();
          }),
        ),
      );
    },
  };
}

function parentCommand(path: string): string {
  const slash = path.lastIndexOf("/");
  const parent = slash <= 0 ? "" : path.slice(0, slash);

  return parent === "" ? "true" : `mkdir -p -- ${quoteShellArgument(parent)}`;
}

function partCommand(part: string, slice: Uint8Array): string {
  const encoded = Buffer.from(slice).toString("base64");

  return `printf '%s' ${quoteShellArgument(encoded)} | base64 -d > ${quoteShellArgument(part)}`;
}

function assembleCommand(path: string, parts: readonly string[]): string {
  return `cat ${parts.map(quoteShellArgument).join(" ")} > ${quoteShellArgument(path)}`;
}

function cleanupCommand(parts: readonly string[]): string {
  return `rm -f ${parts.map(quoteShellArgument).join(" ")}`;
}

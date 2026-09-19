import { Effect } from "effect";
import { attachmentWorkspacePath, COMPUTER_HOME_DIRECTORY, messageFiles } from "@porkbot/core";
import { createComputerFileWriter } from "@porkbot/effect";
import type { ComputerCommandRunner } from "@porkbot/effect";
import type { ComputerRef, StorageProvider } from "@porkbot/adapter-kit";
import type { RunRecord, SystemRepositories } from "@porkbot/db";

/**
 * Materializing a message's attachments into the run's computer (slice 7.6,
 * story 32).
 *
 * An attachment lives in the storage seam and must be readable by the agent
 * before the run starts. This module is the bridge: it reads the run's source
 * message, resolves the attachment rows the message's blocks reference,
 * streams each object's bytes into the computer at the deterministic
 * home-relative path the prompt names, and returns what it placed. The run's
 * machine is bound here, never chosen by a message; the writes travel through
 * the same fenced command runner the computer tools use, so a reclaimed run
 * cannot half-write under an owner that no longer exists, and a retried
 * materialization overwrites the same parts.
 *
 * A run with no source message (a routine fire) and a message with no file
 * blocks are both a no-op. A referenced object the storage seam no longer
 * holds fails the run's work with a typed error rather than starting a run
 * whose prompt names a file that is not there.
 */

export interface MaterializeAttachmentsOptions {
  readonly computer: ComputerRef;
  readonly commands: ComputerCommandRunner;
  readonly repositories: SystemRepositories;
  readonly storage: StorageProvider;
  /** The home directory the provider serves; defaults to the shared default. */
  readonly home?: string | undefined;
  /** The per-command budget for the transfer; defaults to the writer's own. */
  readonly timeoutMs?: number | undefined;
}

/** One file placed in the home, as the prompt already names it. */
export interface MaterializedAttachment {
  readonly attachmentId: string;
  /** The home-relative path the file was written to. */
  readonly path: string;
  readonly bytes: number;
}

/** A message references bytes the storage seam no longer holds. */
export class AttachmentBytesMissingError extends Error {
  constructor(attachmentId: string) {
    super(`the stored bytes for attachment ${attachmentId} are missing`);
    this.name = "AttachmentBytesMissingError";
  }
}

export function materializeRunAttachments(
  run: RunRecord,
  options: MaterializeAttachmentsOptions,
): Effect.Effect<readonly MaterializedAttachment[], unknown> {
  return Effect.gen(function* () {
    if (run.sourceMessageId === null) {
      return [];
    }

    const message = yield* Effect.tryPromise({
      try: () => options.repositories.messages.findSourceForRun(run.id),
      catch: (error) => error,
    });

    if (message === undefined) {
      return [];
    }

    const files = messageFiles(message.blocks);

    if (files === undefined || files.length === 0) {
      return [];
    }

    // The attachment rows are read by id in block order; a missing or foreign
    // row is the shared not-found and fails the materialization rather than
    // silently skipping a file the prompt names.
    const rows = yield* Effect.tryPromise({
      try: () =>
        options.repositories.files.findAttachments(
          message.threadId,
          files.map((file) => file.attachmentId),
        ),
      catch: (error) => error,
    });

    const writer = createComputerFileWriter({
      computer: options.computer,
      commands: options.commands,
      runId: run.id,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const home = options.home ?? COMPUTER_HOME_DIRECTORY;
    const materialized: MaterializedAttachment[] = [];

    for (const row of rows) {
      const path = attachmentWorkspacePath(row.id, row.filename);
      const object = yield* Effect.tryPromise({
        try: () => options.storage.get(row.storageKey),
        catch: (error) => error,
      });

      if (object === undefined) {
        return yield* Effect.fail(new AttachmentBytesMissingError(row.id));
      }

      const written = yield* writer.write({
        callId: `attachment:${row.id}`,
        path: `${home}/${path}`,
        bytes: object.body,
      });

      materialized.push({ attachmentId: row.id, path, bytes: written.bytes });
    }

    return materialized;
  });
}

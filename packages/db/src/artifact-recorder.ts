import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { StorageProvider } from "@porkbot/adapter-kit";
import { fileDownloadPath } from "@porkbot/contracts";
import type { ArtifactRecorder } from "@porkbot/effect";
import type { RunFileStore } from "./file-store.ts";

/**
 * The artifact recorder (slice 7.6, story 33): the seam `@porkbot/effect`
 * declares, implemented over the storage seam and the run's file store.
 *
 * The bytes are written first and the row second, so the failure window leaves
 * an unreferenced object rather than a row whose bytes are missing; the key is
 * deterministic in `(space, run, call id)`, so a retried recording overwrites
 * the same object, and `recordArtifact` is idempotent on `(run_id, call_id)`,
 * so the retry finds the first row. Together those are what make "a tool call
 * records one artifact" true under the ledger's replay discipline.
 *
 * The key is built from a hash of the call id rather than the id itself: a
 * call id is runtime input and may contain a slash, and a storage key's
 * segments are the store's addressing, not a place for caller text.
 */

export interface ArtifactRecorderOptions {
  readonly files: RunFileStore;
  readonly storage: StorageProvider;
  readonly spaceId: string;
  readonly runId: string;
}

/** Where one call's artifact bytes live; deterministic, so a retry lands on the same object. */
export function artifactStorageKey(spaceId: string, runId: string, callId: string): string {
  const digest = createHash("sha256").update(callId).digest("hex");

  return `artifacts/${spaceId}/${runId}/${digest}`;
}

export function createArtifactRecorder(options: ArtifactRecorderOptions): ArtifactRecorder {
  return {
    record: (request) =>
      Effect.tryPromise({
        try: async () => {
          const storageKey = artifactStorageKey(options.spaceId, options.runId, request.callId);

          await options.storage.put({
            key: storageKey,
            body: singleChunk(request.bytes),
            contentType: request.contentType,
          });

          const row = await options.files.recordArtifact({
            runId: options.runId,
            callId: request.callId,
            filename: request.filename,
            contentType: request.contentType,
            sizeBytes: request.bytes.byteLength,
            storageKey,
          });

          return {
            id: row.id,
            filename: row.filename,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
            downloadPath: fileDownloadPath(row.id),
          };
        },
        catch: (error) => error,
      }),
  };
}

/** The body the storage seam wants; the tool's content is already whole. */
async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

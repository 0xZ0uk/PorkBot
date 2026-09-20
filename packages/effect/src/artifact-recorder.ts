import type { Effect } from "effect";

/**
 * The artifact seam (slice 7.6, story 33): the one door a tool hands a
 * produced file through.
 *
 * A tool that writes a file in the computer has produced something the run's
 * output should keep, but the tool layer must not know where bytes are stored,
 * what a row looks like or which space the run belongs to. It calls `record`
 * with the call's durable id and the bytes it just wrote; the implementation
 * binds the run, writes through the storage seam and records the row, and
 * answers the pointer a tool result and the console link carry.
 *
 * The seam is optional on a tool set: a deployment without storage records no
 * artifacts and the tools behave exactly as before, while a miscomposition
 * that fails mid-record surfaces as the tool call's classified failure rather
 * than a silent drop.
 */

/** One file a tool produced, ready to be stored. */
export interface ArtifactRecordRequest {
  /** The tool call's durable id; the recording is idempotent on it. */
  readonly callId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** The recorded artifact as a tool result and the console carry it. */
export interface RecordedArtifact {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The API path the bytes are downloadable from, after the run and a reload. */
  readonly downloadPath: string;
}

export interface ArtifactRecorder {
  readonly record: (request: ArtifactRecordRequest) => Effect.Effect<RecordedArtifact, unknown>;
}

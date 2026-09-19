import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The computer lifecycle surface (slice 7.1, PRD decision 20; stories 27, 29).
 *
 * A bot's computer belongs to the supervisor process; the API holds a client
 * for that process and nothing else, so these procedures are the operator's
 * whole reach into a machine: what state it is in, and the four lifecycle
 * operations the supervisor owns. The input names a bot, never a space, a
 * computer or a provider — the actor-scoped repository resolves the bot and
 * its assignment, so a caller cannot address another space's machine, and the
 * `computerId` column stays the deployment's bookkeeping rather than a value
 * the wire carries.
 *
 * `state` mirrors `@porkbot/adapter-kit`'s computer vocabulary; the suite
 * beside this module pins the two so the transport cannot drift from what
 * lifecycle code branches on. A bot with no assignment is a normal answer
 * (`assigned: false`), not an error, so a bots screen can render "no computer"
 * without catching; the lifecycle operations, which would have nothing to act
 * on, answer the shared `NOT_FOUND` instead.
 *
 * A supervisor that is down or refuses a call is the typed
 * `SERVICE_UNAVAILABLE`: the API holds no Docker socket and no provider
 * credential, so "the computer service is unreachable" is a deployment fact,
 * never a defect to guess about.
 *
 * Snapshots are the operator's recovery path (slice 7.5, PRD story 30).
 * `snapshot` captures the bot's computer and records it in the actor's space;
 * `snapshots` lists what is recoverable; `restore` replays one into the bot's
 * machine, replacing whatever state it was in. What a snapshot holds is the
 * agent home and the provider's declared state — files, not processes: running
 * commands, open sessions and network connections are not captured, and a
 * restore brings the files back into a fresh machine. A snapshot that is
 * missing, or whose bytes no longer match what was captured, is the typed
 * `NOT_FOUND` and the existing computer is left alone.
 */

/**
 * The three states a computer can be in. `@porkbot/adapter-kit` owns the
 * vocabulary and this mirrors it for the wire; the suite beside this module
 * fails when the two drift.
 */
export const computerStateSchema = z.enum(["running", "stopped", "gone"]);

export type ComputerStateView = z.infer<typeof computerStateSchema>;

/**
 * What the operator sees. An unassigned bot has no state to report, and a
 * provider's live instance handle appears only when there is one, so the
 * schema never carries a placeholder for "none".
 */
export const computerViewSchema = z.discriminatedUnion("assigned", [
  z.object({ assigned: z.literal(false) }),
  z.object({
    assigned: z.literal(true),
    state: computerStateSchema,
    instanceId: z.string().optional(),
  }),
]);

export type ComputerView = z.infer<typeof computerViewSchema>;

const computerErrors = {
  /** No such bot in the actor's space, or no computer assigned to it. */
  NOT_FOUND: {
    status: 404,
    message: "No such bot with a computer in this space",
  },
  /** The supervisor could not be reached or refused the lifecycle call. */
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "The computer service is not available.",
  },
} as const;

export const computersStatusContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/computer",
    operationId: "computersStatus",
    summary: "The bot's computer and its current state",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
    SERVICE_UNAVAILABLE: computerErrors.SERVICE_UNAVAILABLE,
  })
  .output(computerViewSchema);

export const computersBootContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/boot",
    operationId: "computersBoot",
    summary: "Bring the bot's computer up, or adopt the running one",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(computerErrors)
  .output(computerViewSchema);

export const computersStopContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/stop",
    operationId: "computersStop",
    summary: "Park the bot's computer, keeping its home and artifacts",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(computerErrors)
  .output(computerViewSchema);

export const computersResetContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/reset",
    operationId: "computersReset",
    summary: "Destroy the bot's computer and bring a clean one up",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(computerErrors)
  .output(computerViewSchema);

export const computersRecoverContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/recover",
    operationId: "computersRecover",
    summary: "Adopt, start or re-provision the computer whatever state it is in",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(computerErrors)
  .output(computerViewSchema);

/**
 * One captured snapshot as the operator sees it: the row that a restore names,
 * when it was taken and how large the archive is. The storage key and the
 * checksum stay server-side — the client names a snapshot, never a location.
 */
export const computerSnapshotViewSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  sizeBytes: z.number().int().nonnegative(),
});

export type ComputerSnapshotView = z.infer<typeof computerSnapshotViewSchema>;

const snapshotErrors = {
  /** No such bot in the actor's space, or no computer assigned to it. */
  NOT_FOUND: {
    status: 404,
    message: "No such bot, computer or snapshot in this space",
  },
  SERVICE_UNAVAILABLE: computerErrors.SERVICE_UNAVAILABLE,
} as const;

export const computersSnapshotContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/snapshots",
    operationId: "computersSnapshot",
    summary: "Capture the bot's computer home as a snapshot",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(snapshotErrors)
  .output(computerSnapshotViewSchema);

export const computersSnapshotsContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/computer/snapshots",
    operationId: "computersSnapshots",
    summary: "List the bot's captured snapshots, newest first",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors(snapshotErrors)
  .output(z.object({ snapshots: z.array(computerSnapshotViewSchema) }));

export const computersRestoreContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/restore",
    operationId: "computersRestore",
    summary: "Restore a captured snapshot into the bot's computer",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      /** The snapshot row a capture returned; never a storage key. */
      snapshotId: z.uuid(),
    }),
  )
  .errors(snapshotErrors)
  .output(computerViewSchema);

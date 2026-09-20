import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";
import { providerFailureKindSchema } from "./model-connections.ts";

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
 * `computers.providers` is the selection read (slice 9.4, PRD story 31): which
 * kinds this deployment configured and whether each can currently serve a
 * machine. It names no bot and no computer, and it changes nothing — the
 * readiness check it reports is the supervisor's own, made without creating a
 * machine — so the operator can see "Docker is not reachable" before storing a
 * bot on it, and `bots.create`/`bots.update` refuse a kind the check rejects.
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
 *
 * The terminal and file views are v1.0's observability into a machine (slice
 * 11.4, PRD story 27; screen watch and takeover are v1.1, PRD story 28).
 * `terminal` runs one operator-typed command through the same supervisor exec
 * seam the model's `shell` tool uses and answers its exit code, stdout and
 * stderr; the command is deliberately not classified as a dangerous action —
 * a command string names no single class, and the sandbox is its boundary
 * (PRD decision 30). The file view is home-scoped: `files` lists a directory
 * of the bot's home and `file` reads one file from it, and a path that leaves
 * the home is the typed `BAD_REQUEST` rather than a read the model's tools
 * would have had to ask an operator to approve. The home is the whole
 * namespace of the view; the terminal is the escape hatch to the rest of the
 * machine.
 *
 * Screen watch and takeover reserve `frames()` and `input()` on
 * `ComputerProvider` and the capability-gated `/v1/computers/:id/frames` and
 * `/input` supervisor paths, which answer `not_implemented` in v1.0. No
 * procedure here carries a frame and no UI renders one: the seam is documented
 * at the adapter interface and in `apps/web`, so a v1.1 stream is one adapter
 * plus one surface rather than a redesign.
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

/**
 * One selectable kind and whether the deployment can currently serve it (slice
 * 9.4, PRD story 31). `available` is the last check's own answer: an
 * unreachable daemon, a refused key and a missing image are shown as the
 * unavailable provider they are, before a bot is stored on it, rather than
 * surfacing at the bot's first run. `failure` names the shared vocabulary's
 * kind when the check was refused, and is `null` when it was not.
 */
export const computerProviderSchema = z.object({
  kind: z.string().min(1),
  available: z.boolean(),
  failure: providerFailureKindSchema.nullable(),
});

export type ComputerProviderView = z.infer<typeof computerProviderSchema>;

/**
 * Every kind this deployment configured, and which one a bot with no selection
 * runs on. The list is the deployment's own answer from its supervisor, so a
 * client renders exactly the kinds that exist rather than a compiled-in set.
 */
export const computerProvidersViewSchema = z.object({
  /** The kind a bot with no selection runs on. */
  defaultKind: z.string().min(1),
  providers: z.array(computerProviderSchema),
});

export type ComputerProvidersView = z.infer<typeof computerProvidersViewSchema>;

/**
 * The selection read: which kinds exist and which are usable. It names no bot
 * and no computer — it is a property of the deployment, not of one machine —
 * and it changes nothing, so an operator can open the choice without touching
 * a computer.
 */
export const computersProvidersContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/computers/providers",
    operationId: "computersProviders",
    summary: "The configured computer providers and whether they are usable",
  })
  .input(z.object({}))
  .errors({
    SERVICE_UNAVAILABLE: computerErrors.SERVICE_UNAVAILABLE,
  })
  .output(computerProvidersViewSchema);

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

/**
 * The longest command the terminal accepts. The supervisor's own cap is the
 * machine's (64 KiB) and the run tools' is lower (16 KiB); the terminal sits
 * at the tool limit so an operator command is no larger than a model's.
 */
export const maxTerminalCommandLength = 16_384;

/** The longest path the file view accepts, home-relative or absolute. */
export const maxComputerPathLength = 4_096;

/** The most bytes one terminal stream or file read carries before the rest is marked cut. */
export const maxComputerOutputBytes = 65_536;

/**
 * The command input and the two path inputs. A NUL byte is refused at the
 * transport with the ordinary validation refusal: no shell can carry one, and
 * a typed refusal for it would have to claim the path was outside the home.
 */
const commandInputSchema = z
  .string()
  .min(1)
  .max(maxTerminalCommandLength)
  .refine((value) => !value.includes("\u0000"), "a command cannot contain a NUL byte");

const optionalPathInputSchema = z
  .string()
  .max(maxComputerPathLength)
  .refine((value) => !value.includes("\u0000"), "a path cannot contain a NUL byte");

const pathInputSchema = z
  .string()
  .min(1)
  .max(maxComputerPathLength)
  .refine((value) => !value.includes("\u0000"), "a path cannot contain a NUL byte");

/**
 * One terminal run as the operator sees it. `exitCode` is the command's own
 * answer — a failing command is a normal result, not an error — and the two
 * streams are the machine's output, bounded and marked when the bound cut
 * them.
 */
export const computerTerminalViewSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export type ComputerTerminalView = z.infer<typeof computerTerminalViewSchema>;

/**
 * One directory row: the name as the machine listed it, whether it is a
 * directory or a file, and the size the machine reported (zero for a
 * directory, which carries no meaningful byte count).
 */
export const computerFileEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  sizeBytes: z.number().int().nonnegative(),
});

export type ComputerFileEntryView = z.infer<typeof computerFileEntrySchema>;

/**
 * One directory listing. `path` is the home-relative path that was listed,
 * with the empty string for the home itself, so the client renders a
 * breadcrumb from the server's own answer rather than from what it guessed.
 */
export const computerDirectoryViewSchema = z.object({
  path: z.string(),
  entries: z.array(computerFileEntrySchema),
});

export type ComputerDirectoryView = z.infer<typeof computerDirectoryViewSchema>;

/** One file's content, bounded; `truncated` says the bound cut it. */
export const computerFileViewSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  truncated: z.boolean(),
});

export type ComputerFileView = z.infer<typeof computerFileViewSchema>;

const terminalErrors = {
  /** No such bot in the actor's space, or no computer assigned to it. */
  NOT_FOUND: {
    status: 404,
    message: "No such bot with a computer in this space",
  },
  SERVICE_UNAVAILABLE: computerErrors.SERVICE_UNAVAILABLE,
} as const;

const browseErrors = {
  /** No such bot, computer, directory or file in the actor's space. */
  NOT_FOUND: {
    status: 404,
    message: "No such bot, computer, directory or file in this space",
  },
  /** The path leaves the bot's home; the file view's namespace is the home. */
  BAD_REQUEST: {
    status: 400,
    message: "That path is outside the bot's home directory.",
  },
  SERVICE_UNAVAILABLE: computerErrors.SERVICE_UNAVAILABLE,
} as const;

/**
 * Run one command in the bot's computer. This is the operator's shell, not a
 * tool call: it carries no run, no approval gate and no fence, because the
 * supervisor's exec is the same command seam with the machine's own isolation
 * as the boundary. The output is the machine's own bytes; the client renders
 * them as data, never as instructions.
 */
export const computersTerminalContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/bots/{botId}/computer/terminal",
    operationId: "computersTerminal",
    summary: "Run one command in the bot's computer and return its output",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      command: commandInputSchema,
    }),
  )
  .errors(terminalErrors)
  .output(computerTerminalViewSchema);

/**
 * List one directory of the bot's computer home. `path` is home-relative and
 * optional; omitting it lists the home. The reply is the machine's real
 * listing through the supervisor, never a cached index, and it lists what the
 * model's `file_list` lists — no hidden entries; the terminal shows those.
 */
export const computersFilesContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/computer/files",
    operationId: "computersFiles",
    summary: "List a directory of the bot's computer home",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      path: optionalPathInputSchema.optional(),
    }),
  )
  .errors(browseErrors)
  .output(computerDirectoryViewSchema);

/** Read one file of the bot's computer home, bounded and marked when cut. */
export const computersFileContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/computer/file",
    operationId: "computersFile",
    summary: "Read a file from the bot's computer home",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      path: pathInputSchema,
    }),
  )
  .errors(browseErrors)
  .output(computerFileViewSchema);

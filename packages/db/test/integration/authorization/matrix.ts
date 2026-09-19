import { randomUUID } from "node:crypto";
import { RUN_EVENT_SCHEMA_VERSION, UnknownMemoryDocument } from "@porkbot/core";
import type { MemoryWriteDecision, RunEvent } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type {
  ApprovalDecisions,
  ApprovalStore,
  Credentials,
  CredentialStore,
  McpRunServers,
  McpServers,
  MemoryDocuments,
  MemoryProposals,
  RunEventSink,
  ToolCallLedger,
} from "@porkbot/effect";
import {
  createApprovalStore,
  createCredentialKeyring,
  createEncryptedCredentialStore,
  createExternalEffectLedger,
  createMcpStore,
  createMemoryStore,
  createRepositories,
  createRunEventSink,
} from "../../../src/index.ts";
import type {
  BotRecord,
  BotSectionRecord,
  Queryable,
  SystemActor,
  SystemRepositories,
  UserActor,
  UserRepositories,
} from "../../../src/index.ts";

/**
 * The authorization matrix's resource register (slice 3.3): every space-scoped
 * entity and the probes that exercise a read and a write through its real
 * seam. The spec beside this file runs each probe twice — once against the
 * actor's own space and once against another space — and the spec's coverage
 * test reads `pg_catalog`-level truth from the Drizzle schema, so a table that
 * is not named here fails the suite instead of shipping unaudited.
 *
 * A probe returns an observable rather than throwing a test failure: `visible`
 * / `refused` for reads and `applied` / `refused` for writes. "Refused" means
 * the typed `NotFoundError` every scoped read and write raises, or an empty
 * answer where the seam expresses refusal as a list that omits the row (the
 * transcript, memory, sections). A swallowed defect is impossible by
 * construction: the helpers rethrow anything that is not the typed refusal.
 *
 * Some tables are parts of an aggregate rather than addressable resources —
 * `task` and `attempt` live and die with the run command that writes them,
 * `steering_message` with the steer command, `routine_occurrence` with the
 * scheduler's fire. They are named on the entry whose probes write them, so the
 * coverage test still fails when one appears without a probe; they do not get
 * an entry of their own because there is no seam that addresses them alone.
 *
 * Probes are hand-written per entity on purpose. A generated probe would have
 * to guess which seam enforcement lives in, and that guess is the bug class
 * this matrix exists to catch.
 */

export type Visibility = "visible" | "refused";
export type Change = "applied" | "refused";

/** An operator and the actor-scoped seams their space owns. */
export interface UserSubject {
  readonly actor: UserActor;
  readonly repositories: UserRepositories;
  readonly memory: MemoryDocuments;
  readonly approvals: ApprovalDecisions;
}

/** A job's actor and the seams a handler is given for its space. */
export interface SystemSubject {
  readonly actor: SystemActor;
  readonly repositories: SystemRepositories;
  readonly memory: MemoryProposals;
  readonly approvals: ApprovalStore;
  readonly ledger: ToolCallLedger;
  readonly eventSink: RunEventSink;
  readonly credentials: CredentialStore;
}

/**
 * A fixed test keyring: real AES-256-GCM over invented bytes, so the store's
 * encryption path runs without a secret anywhere near the repository.
 */
const keyring = createCredentialKeyring({
  activeKeyId: "matrix",
  keys: [{ id: "matrix", key: Buffer.alloc(32, 0x11).toString("base64") }],
});

/** Everything a resource seed may need, built once per space. */
export interface SpaceHandle {
  readonly label: string;
  readonly spaceId: string;
  readonly owner: UserActor;
  readonly member: UserActor;
  readonly system: SystemActor;
  readonly ownerRepositories: UserRepositories;
  readonly memberRepositories: UserRepositories;
  readonly systemRepositories: SystemRepositories;
  readonly memory: MemoryDocuments;
  readonly memberMemory: MemoryDocuments;
  readonly systemMemory: MemoryProposals;
  readonly approvals: ApprovalDecisions;
  readonly systemApprovals: ApprovalStore;
  readonly ledger: ToolCallLedger;
  readonly eventSink: RunEventSink;
  readonly credentials: Credentials;
  readonly memberCredentials: Credentials;
  readonly systemCredentials: CredentialStore;
  readonly mcp: McpServers;
  readonly memberMcp: McpServers;
  readonly systemMcp: McpRunServers;
  readonly query: <Row>(text: string, values?: readonly unknown[]) => Promise<readonly Row[]>;
}

export interface UserProbes<Seed> {
  readonly read?: (subject: UserSubject, seed: Seed) => Promise<Visibility>;
  readonly write?: (subject: UserSubject, seed: Seed) => Promise<Change>;
  /**
   * Whether every member of the space sees the row. `bot_section` is the
   * exception: its name is unique per `(space, user)`, so the spec also proves
   * a second member of the same space cannot read it.
   */
  readonly sharedInSpace?: boolean;
}

export interface SystemProbes<Seed> {
  readonly read?: (subject: SystemSubject, seed: Seed) => Promise<Visibility>;
  readonly write?: (subject: SystemSubject, seed: Seed) => Promise<Change>;
}

export interface Resource<Seed> {
  readonly entity: string;
  /** The schema tables this entry's probes protect. */
  readonly tables: readonly string[];
  readonly seed: (space: SpaceHandle) => Promise<Seed>;
  /** A serializable fingerprint the spec compares around a refused write. */
  readonly state: (space: SpaceHandle, seed: Seed) => Promise<string>;
  readonly user?: UserProbes<Seed>;
  readonly system?: SystemProbes<Seed>;
}

/**
 * Preserves each entry's seed type at its definition site while the exported
 * array is heterogeneous. The cast is the price of one register; the probes
 * themselves stay fully typed where they are written.
 */
export function resource<Seed>(entry: Resource<Seed>): Resource<unknown> {
  return entry as unknown as Resource<unknown>;
}

/**
 * Builds a space, its two memberships and every actor-scoped seam over one
 * connection. Two of these — the acting space and another space — are all the
 * matrix needs: a cross-space attempt is always "this actor, that space's
 * rows".
 */
export async function mountSpace(database: Queryable, label: string): Promise<SpaceHandle> {
  const { rows } = await database.query<{ readonly id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [label],
  );
  const space = rows[0];

  if (space === undefined) {
    throw new Error(`mountSpace: the space insert returned no id for ${label}`);
  }

  const spaceId = space.id;
  const owner = await insertMember(database, spaceId, `${label} owner`, "owner");
  const member = await insertMember(database, spaceId, `${label} member`, "member");
  const system: SystemActor = { kind: "system", spaceId, jobId: `matrix ${label}` };

  return {
    label,
    spaceId,
    owner,
    member,
    system,
    ownerRepositories: createRepositories(owner, database),
    memberRepositories: createRepositories(member, database),
    systemRepositories: createRepositories(system, database),
    memory: createMemoryStore(owner, database),
    memberMemory: createMemoryStore(member, database),
    systemMemory: createMemoryStore(system, database),
    approvals: createApprovalStore(owner, database),
    systemApprovals: createApprovalStore(system, database),
    ledger: createExternalEffectLedger(system, database),
    eventSink: createRunEventSink(system, database),
    credentials: createEncryptedCredentialStore(owner, database, keyring),
    memberCredentials: createEncryptedCredentialStore(member, database, keyring),
    systemCredentials: createEncryptedCredentialStore(system, database, keyring),
    mcp: createMcpStore(owner, database),
    memberMcp: createMcpStore(member, database),
    systemMcp: createMcpStore(system, database),
    query: (text, values) => database.query(text, values),
  };
}

export function userSubject(space: SpaceHandle): UserSubject {
  return {
    actor: space.owner,
    repositories: space.ownerRepositories,
    memory: space.memory,
    approvals: space.approvals,
  };
}

export function memberSubject(space: SpaceHandle): UserSubject {
  return {
    actor: space.member,
    repositories: space.memberRepositories,
    memory: space.memberMemory,
    approvals: space.approvals,
  };
}

export function systemSubject(space: SpaceHandle): SystemSubject {
  return {
    actor: space.system,
    repositories: space.systemRepositories,
    memory: space.systemMemory,
    approvals: space.systemApprovals,
    ledger: space.ledger,
    eventSink: space.eventSink,
    credentials: space.systemCredentials,
  };
}

/** Resolves when the work was allowed, is `refused` on the typed not-found. */
export async function visibleOn(work: () => Promise<unknown>): Promise<Visibility> {
  try {
    await work();

    return "visible";
  } catch (error) {
    return refusedVisibility(error);
  }
}

/** Resolves when the work was allowed, is `refused` on the typed not-found. */
export async function appliedOn(work: () => Promise<unknown>): Promise<Change> {
  try {
    await work();

    return "applied";
  } catch (error) {
    if (error instanceof NotFoundError) {
      return "refused";
    }

    throw error;
  }
}

function refusedVisibility(error: unknown): Visibility {
  if (error instanceof NotFoundError) {
    return "refused";
  }

  throw error;
}

/**
 * A memory write answers with a decision instead of throwing. A cross-space
 * write lands as `UnknownMemoryDocument`, because the scoped pre-read saw no
 * live document to update; any other decision error is a fixture defect rather
 * than a refusal, so the probe fails loudly instead of counting it as
 * enforcement.
 */
function memoryChange(decision: MemoryWriteDecision): Change {
  if (decision.ok) {
    return "applied";
  }

  if (decision.error instanceof UnknownMemoryDocument) {
    return "refused";
  }

  throw new Error(`unexpected memory write decision: ${String(decision.error)}`);
}

async function insertMember(
  database: Queryable,
  spaceId: string,
  name: string,
  role: "owner" | "member",
): Promise<UserActor> {
  const { rows } = await database.query<{ readonly id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    [name, `${randomUUID()}@example.test`],
  );
  const user = rows[0];

  if (user === undefined) {
    throw new Error(`mountSpace: the user insert returned no id for ${name}`);
  }

  await database.query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    user.id,
    role,
  ]);

  return { kind: "user", spaceId, userId: user.id, role };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function createBot(space: SpaceHandle, name: string): Promise<BotRecord> {
  return await space.ownerRepositories.bots.create({
    name,
    color: "#123456",
    spawnKey: randomUUID(),
  });
}

interface ThreadSeed {
  readonly botId: string;
  readonly threadId: string;
}

interface RunSeed extends ThreadSeed {
  readonly runId: string;
  readonly taskId: string;
  readonly messageId: string;
}

async function seedRun(space: SpaceHandle, name: string): Promise<RunSeed> {
  const bot = await createBot(space, name);
  const thread = await space.ownerRepositories.threads.createForBot(bot.id);
  const created = await space.ownerRepositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "matrix",
    blocks: [],
  });

  return {
    botId: bot.id,
    threadId: thread.id,
    runId: created.run.id,
    taskId: created.task.id,
    messageId: created.message.id,
  };
}

export const resources: readonly Resource<unknown>[] = [
  resource<BotRecord>({
    entity: "bot",
    tables: ["bot"],
    seed: (space) => createBot(space, "Matrix bot"),
    state: async (space, seed) =>
      json(
        await space.query(
          'select name, title, archived_at as "archivedAt", avatar_key as "avatarKey", ' +
            'section_id as "sectionId" from bot where id = $1',
          [seed.id],
        ),
      ),
    user: {
      read: (subject, seed) => visibleOn(() => subject.repositories.bots.findById(seed.id)),
      write: (subject, seed) =>
        appliedOn(() => subject.repositories.bots.update(seed.id, { title: "matrix" })),
    },
    system: {
      read: (subject, seed) => visibleOn(() => subject.repositories.bots.findById(seed.id)),
    },
  }),

  resource<BotSectionRecord>({
    entity: "bot_section",
    tables: ["bot_section"],
    seed: (space) =>
      space.ownerRepositories.sections.create({ name: `Matrix list ${randomUUID()}` }),
    state: async (space, seed) =>
      json(await space.query("select name, position from bot_section where id = $1", [seed.id])),
    user: {
      sharedInSpace: false,
      read: async (subject, seed) =>
        (await subject.repositories.sections.list()).some((section) => section.id === seed.id)
          ? "visible"
          : "refused",
      write: (subject, seed) =>
        appliedOn(() => subject.repositories.sections.update(seed.id, { position: 7 })),
    },
  }),

  resource<ThreadSeed>({
    entity: "thread",
    tables: ["thread"],
    seed: async (space) => {
      const bot = await createBot(space, "Thread host");

      return {
        botId: bot.id,
        threadId: (await space.ownerRepositories.threads.createForBot(bot.id)).id,
      };
    },
    state: async (space, seed) =>
      json(
        await space.query(
          'select next_message_seq as "nextMessageSeq", next_event_seq as "nextEventSeq" ' +
            "from thread where id = $1",
          [seed.threadId],
        ),
      ),
    user: {
      read: (subject, seed) =>
        visibleOn(() => subject.repositories.threads.findById(seed.threadId)),
      write: (subject, seed) => appliedOn(() => subject.repositories.threads.clear(seed.threadId)),
    },
    system: {
      read: (subject, seed) =>
        visibleOn(() => subject.repositories.threads.findById(seed.threadId)),
    },
  }),

  resource<RunSeed>({
    entity: "transcript",
    tables: ["message", "steering_message"],
    seed: (space) => seedRun(space, "Transcript host"),
    state: async (space, seed) =>
      json(
        await space.query(
          "select (select count(*)::int from message where thread_id = $1) as messages, " +
            "(select count(*)::int from steering_message where bot_id = $2) as steers",
          [seed.threadId, seed.botId],
        ),
      ),
    user: {
      read: async (subject, seed) => {
        const page = await subject.repositories.messages.listForThread(seed.threadId, {
          limit: 50,
          afterSeq: -1,
        });

        return page.some((message) => message.id === seed.messageId) ? "visible" : "refused";
      },
      write: (subject, seed) =>
        appliedOn(() =>
          subject.repositories.messages.steer({
            threadId: seed.threadId,
            clientNonce: randomUUID(),
            blocks: [],
            runId: seed.runId,
          }),
        ),
    },
    system: {
      // The worker writes the run's own output as an assistant message.
      write: (subject, seed) =>
        appliedOn(() =>
          subject.repositories.messages.append({
            threadId: seed.threadId,
            runId: seed.runId,
            clientNonce: randomUUID(),
            blocks: [],
          }),
        ),
    },
  }),

  resource<RunSeed>({
    entity: "run",
    tables: ["run", "task", "attempt"],
    seed: (space) => seedRun(space, "Run host"),
    state: async (space, seed) =>
      json(
        await space.query(
          "select (select status::text from run where id = $1) as status, " +
            "(select lease_fence from run where id = $1) as fence, " +
            "(select count(*)::int from task where thread_id = $2) as tasks, " +
            "(select count(*)::int from run where thread_id = $2) as runs, " +
            "(select count(*)::int from attempt where run_id = $1) as attempts",
          [seed.runId, seed.threadId],
        ),
      ),
    user: {
      read: (subject, seed) => visibleOn(() => subject.repositories.runs.findById(seed.runId)),
      // The single run-creation command is what writes the run and its task.
      write: (subject, seed) =>
        appliedOn(() =>
          subject.repositories.runs.create({
            threadId: seed.threadId,
            clientNonce: randomUUID(),
            prompt: "matrix again",
            blocks: [],
          }),
        ),
    },
    system: {
      read: (subject, seed) => visibleOn(() => subject.repositories.runs.findById(seed.runId)),
      // The claim is the only path that writes an attempt row.
      write: async (subject, seed) => {
        const claimed = await subject.repositories.runs.claim(seed.runId, 0, "matrix job");

        return claimed === undefined ? "refused" : "applied";
      },
    },
  }),

  resource<{ readonly threadId: string; readonly runId: string }>({
    entity: "event",
    tables: ["event"],
    seed: async (space) => {
      const seed = await seedRun(space, "Event host");

      await space.query(
        "insert into event (space_id, thread_id, seq, type, payload, run_id) " +
          "values ($1, $2, 0, 'run.started', '{}', $3)",
        [space.spaceId, seed.threadId, seed.runId],
      );

      return { threadId: seed.threadId, runId: seed.runId };
    },
    state: async (space, seed) =>
      json(
        await space.query("select seq, type from event where thread_id = $1 order by seq asc", [
          seed.threadId,
        ]),
      ),
    user: {
      // The operator only ever reads the stream; the sink below is the writer.
      read: async (subject, seed) => {
        const events = await subject.repositories.events.listAfter(seed.threadId, -1, 10);

        return events.some((event) => event.seq === 0) ? "visible" : "refused";
      },
    },
    system: {
      write: (subject, seed) =>
        appliedOn(() => subject.eventSink.append(eventFor(seed.threadId, seed.runId, 1))),
    },
  }),

  resource<{ readonly botId: string; readonly documentId: string }>({
    entity: "memory",
    tables: ["memory_document", "memory_revision"],
    seed: async (space) => {
      const bot = await createBot(space, "Memory host");
      const documentId = randomUUID();

      await space.memory.write(bot.id, {
        write: {
          action: "create",
          documentId,
          kind: "fact",
          title: "Matrix",
          content: "the matrix",
        },
        reason: "matrix fixture",
      });

      return { botId: bot.id, documentId };
    },
    state: async (space, seed) =>
      json(
        await space.query(
          "select (select revision from memory_document where document_id = $1) as revision, " +
            "(select count(*)::int from memory_revision where document_id = $1) as revisions",
          [seed.documentId],
        ),
      ),
    user: {
      read: (subject, seed) =>
        visibleOn(async () => {
          await subject.memory.find(seed.botId, seed.documentId);
          await subject.memory.revisions(seed.botId, seed.documentId);
        }),
      write: async (subject, seed) => {
        const decision = await subject.memory.write(seed.botId, {
          write: {
            action: "update",
            documentId: seed.documentId,
            title: "Matrix",
            content: `the matrix ${randomUUID()}`,
          },
          reason: "matrix write",
        });

        return memoryChange(decision);
      },
    },
    system: {
      read: (subject, seed) => visibleOn(() => subject.memory.find(seed.botId, seed.documentId)),
      write: async (subject, seed) => {
        const decision = await subject.memory.propose(seed.botId, {
          write: {
            action: "update",
            documentId: seed.documentId,
            title: "Matrix proposed",
            content: "proposed",
          },
          reason: "matrix proposal",
        });

        return memoryChange(decision);
      },
    },
  }),

  resource<{ readonly runId: string; readonly callId: string }>({
    entity: "approval",
    tables: ["approval"],
    seed: async (space) => {
      const seed = await seedRun(space, "Approval host");
      const callId = `matrix-${randomUUID()}`;

      await space.systemApprovals.open({
        runId: seed.runId,
        callId,
        tool: "matrix.tool",
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      return { runId: seed.runId, callId };
    },
    state: async (space, seed) =>
      json(
        await space.query(
          'select status::text as status, decided_by_user_id as "decidedBy", reason ' +
            "from approval where run_id = $1 and call_id = $2",
          [seed.runId, seed.callId],
        ),
      ),
    user: {
      read: async (subject, seed) =>
        (await subject.approvals.listForRun(seed.runId)).some(
          (approval) => approval.callId === seed.callId,
        )
          ? "visible"
          : "refused",
      write: (subject, seed) =>
        appliedOn(() =>
          subject.approvals.decide({ runId: seed.runId, callId: seed.callId, vote: "approve" }),
        ),
    },
    system: {
      read: async (subject, seed) =>
        (await subject.approvals.find(seed.runId, seed.callId)) === undefined
          ? "refused"
          : "visible",
      // Re-opening the same `(run, call)` is the idempotent gate write.
      write: (subject, seed) =>
        appliedOn(() =>
          subject.approvals.open({
            runId: seed.runId,
            callId: seed.callId,
            tool: "matrix.tool",
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        ),
    },
  }),

  resource<{ readonly runId: string; readonly callId: string }>({
    entity: "external_effect",
    tables: ["external_effect"],
    seed: async (space) => {
      const seed = await seedRun(space, "Effect host");
      const callId = randomUUID();

      await space.ledger.begin({
        runId: seed.runId,
        callId,
        tool: "matrix.tool",
        arguments: {},
      });

      return { runId: seed.runId, callId };
    },
    state: async (space, seed) =>
      json(
        await space.query(
          "select status::text as status, kind from external_effect where run_id = $1 and idempotency_key = $2",
          [seed.runId, seed.callId],
        ),
      ),
    system: {
      // Replaying the seeded call is the ledger's scoped read of the claim.
      read: (subject, seed) =>
        visibleOn(() =>
          subject.ledger.begin({
            runId: seed.runId,
            callId: seed.callId,
            tool: "matrix.tool",
            arguments: {},
          }),
        ),
      // A fresh call id is a fresh claim: the write the run runtime performs.
      write: (subject, seed) =>
        appliedOn(() =>
          subject.ledger.begin({
            runId: seed.runId,
            callId: randomUUID(),
            tool: "matrix.tool",
            arguments: {},
          }),
        ),
    },
  }),

  resource<{ readonly routineId: string; readonly nextRunAt: Date }>({
    entity: "routine",
    tables: ["routine", "routine_occurrence"],
    seed: async (space) => {
      const bot = await createBot(space, "Routine host");
      const routine = await space.ownerRepositories.routines.create({
        botId: bot.id,
        instruction: "matrix",
        cron: "0 9 * * *",
        timezone: "UTC",
      });

      return { routineId: routine.id, nextRunAt: routine.nextRunAt };
    },
    state: async (space, seed) =>
      json(
        await space.query(
          "select (select enabled from routine where id = $1) as enabled, " +
            "(select deleted_at from routine where id = $1) as deleted, " +
            "(select count(*)::int from routine_occurrence where routine_id = $1) as occurrences",
          [seed.routineId],
        ),
      ),
    user: {
      read: (subject, seed) =>
        visibleOn(async () => {
          await subject.repositories.routines.findById(seed.routineId);
          await subject.repositories.routines.outcomes(seed.routineId, 10);
        }),
      write: (subject, seed) =>
        appliedOn(() =>
          subject.repositories.routines.update(seed.routineId, { instruction: "matrix edited" }),
        ),
    },
    system: {
      // Firing the due slot is what writes the occurrence ledger.
      write: async (subject, seed) => {
        const fired = await subject.repositories.routines.fire({
          routineId: seed.routineId,
          scheduledFor: seed.nextRunAt,
          nextRunAt: new Date(seed.nextRunAt.getTime() + 86_400_000),
        });

        return fired === undefined ? "refused" : "applied";
      },
    },
  }),

  resource<{ readonly serverId: string; readonly botId: string }>({
    entity: "mcp_server",
    tables: ["mcp_server", "mcp_server_tool", "bot_mcp_server"],
    seed: async (space) => {
      const name = `matrix-${randomUUID()}`;
      const server = await space.ownerRepositories.mcp.create({
        name,
        url: "https://mcp.example.invalid/mcp",
        auth: "none",
        credentialName: `mcp:${name}`,
      });

      await space.ownerRepositories.mcp.replaceTools(server.id, [
        { name: "list_issues", description: "List open issues.", parameters: { type: "object" } },
      ]);

      const bot = await createBot(space, "MCP host");
      await space.ownerRepositories.mcp.grant(bot.id, server.id);

      return { serverId: server.id, botId: bot.id };
    },
    state: async (space) => {
      return json(
        await space.query(
          "select (select count(*)::int from mcp_server where space_id = $1) as servers, " +
            "(select count(*)::int from mcp_server_tool where space_id = $1) as tools, " +
            "(select count(*)::int from bot_mcp_server where space_id = $1) as grants, " +
            "(select count(*)::int from bot_mcp_server where space_id = $1 and revoked_at is not null) " +
            "as revoked",
          [space.spaceId],
        ),
      );
    },
    user: {
      read: (subject, seed) =>
        visibleOn(async () => {
          await subject.repositories.mcp.findById(seed.serverId);
          await subject.repositories.mcp.listForServer(seed.serverId);
        }),
      write: (subject, seed) =>
        appliedOn(() =>
          subject.repositories.mcp.replaceTools(seed.serverId, [
            {
              name: "replacement",
              description: "Replaced by the matrix.",
              parameters: { type: "object" },
            },
          ]),
        ),
    },
    system: {
      // The run path's read: the servers and tools one granted bot holds.
      read: (subject, seed) =>
        visibleOn(() => subject.repositories.mcp.listGrantedForBot(seed.botId)),
    },
  }),
];

function eventFor(threadId: string, runId: string, seq: number): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "run.started",
  };
}

import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { MessageAttachmentRecord, RunArtifactRecord } from "./records.ts";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createFileStore, createRunFileStore } from "./file-store.ts";
import type { StoredFile } from "./file-store.ts";

/**
 * The stored-file statements' decisions, without Postgres: which statement each
 * call compiles to, which values it binds, and how an empty result is reported.
 * The space predicate and the cross-space refusal are proven against a real
 * server by the authorization matrix; this suite pins the shape and the
 * not-found discipline the stores compile to.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const system: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

function attachmentRecord(
  overrides: Partial<MessageAttachmentRecord> = {},
): MessageAttachmentRecord {
  return {
    id: "attachment-1",
    spaceId: owner.spaceId,
    threadId: "thread-1",
    botId: "bot-1",
    userId: owner.userId,
    filename: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 2_048,
    storageKey: "files/space-1/random",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function artifactRecord(overrides: Partial<RunArtifactRecord> = {}): RunArtifactRecord {
  return {
    id: "artifact-1",
    spaceId: owner.spaceId,
    threadId: "thread-1",
    botId: "bot-1",
    userId: owner.userId,
    runId: "run-1",
    callId: "call-1",
    filename: "report.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    storageKey: "artifacts/space-1/run-1/hash",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function scripted(rows: readonly unknown[]): Queryable & {
  readonly calls: Array<{ readonly text: string; readonly values: readonly unknown[] }>;
} {
  const queue = [...rows];
  const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];

  return {
    calls,
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      const next = queue.shift();
      const batch = Array.isArray(next) ? next : next === undefined ? [] : [next];

      return { rows: batch as readonly Row[] };
    },
  };
}

describe("uploading an attachment", () => {
  it("attributes the row to the thread and the uploading user, not the caller", async () => {
    const database = scripted([attachmentRecord()]);
    const files = createFileStore(owner, database);

    const created = await files.createAttachment({
      threadId: "thread-1",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_048,
      storageKey: "files/space-1/random",
    });

    expect(created).toEqual(attachmentRecord());
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("insert into message_attachment");
    expect(database.calls[0]?.text).toContain("from thread t where t.id = $7 and t.space_id = $1");
    expect(database.calls[0]?.values).toEqual([
      owner.spaceId,
      owner.userId,
      "report.pdf",
      "application/pdf",
      2_048,
      "files/space-1/random",
      "thread-1",
    ]);
  });

  it("reports a thread outside the actor's space as not-found", async () => {
    const files = createFileStore(owner, scripted([]));

    await expect(
      files.createAttachment({
        threadId: "thread-foreign",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        storageKey: "files/space-2/random",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers a bigint size as a number, whatever the driver sent", async () => {
    // The driver answers a Postgres bigint as a string; the store's contract
    // is a number, so the cast is the store's, not every caller's.
    const asString = { ...attachmentRecord(), sizeBytes: "2048" as unknown as number };
    const database = scripted([asString]);
    const files = createFileStore(owner, database);

    const created = await files.createAttachment({
      threadId: "thread-1",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 2_048,
      storageKey: "files/space-1/random",
    });

    expect(created.sizeBytes).toBe(2_048);
    expect(typeof created.sizeBytes).toBe("number");
  });
});

describe("resolving a send's attachments", () => {
  it("answers an empty list without touching the database", async () => {
    const database = scripted([]);
    const files = createFileStore(owner, database);

    await expect(files.findAttachments("thread-1", [])).resolves.toEqual([]);
    expect(database.calls).toHaveLength(0);
  });

  it("reads only attachments on the named thread, in the caller's order", async () => {
    const second = attachmentRecord({ id: "attachment-2", filename: "notes.txt" });
    const database = scripted([[attachmentRecord(), second]]);
    const files = createFileStore(owner, database);

    await expect(
      files.findAttachments("thread-1", ["attachment-2", "attachment-1"]),
    ).resolves.toEqual([attachmentRecord(), second]);

    const call = database.calls[0];

    expect(call?.text).toContain("from message_attachment");
    expect(call?.text).toContain("thread_id = $2");
    expect(call?.values).toEqual([owner.spaceId, "thread-1", ["attachment-2", "attachment-1"]]);
  });

  it("refuses the whole send when one requested id is not a visible attachment", async () => {
    const files = createFileStore(owner, scripted([[attachmentRecord()]]));

    await expect(
      files.findAttachments("thread-1", ["attachment-1", "attachment-foreign"]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reading a file for a download", () => {
  const stored: StoredFile = {
    id: "attachment-1",
    filename: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 2_048,
    storageKey: "files/space-1/random",
  };

  it("answers an attachment without reading the artifact table", async () => {
    const database = scripted([[stored]]);
    const files = createFileStore(owner, database);

    await expect(files.findStoredFile("attachment-1")).resolves.toEqual(stored);
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("from message_attachment");
    expect(database.calls[0]?.values).toEqual(["attachment-1", owner.spaceId]);
  });

  it("falls through to the artifact table when the attachment read misses", async () => {
    const artifact: StoredFile = { ...stored, id: "artifact-1", filename: "report.txt" };
    const database = scripted([[], [artifact]]);
    const files = createFileStore(owner, database);

    await expect(files.findStoredFile("artifact-1")).resolves.toEqual(artifact);
    expect(database.calls).toHaveLength(2);
    expect(database.calls[1]?.text).toContain("from run_artifact");
  });

  it("reports a missing or foreign id as not-found", async () => {
    const files = createFileStore(owner, scripted([[], []]));

    await expect(files.findStoredFile("file-foreign")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("recording an artifact", () => {
  const input = {
    runId: "run-1",
    callId: "call-1",
    filename: "report.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    storageKey: "artifacts/space-1/run-1/hash",
  };

  it("inserts the row with the run's links and the call's idempotency key", async () => {
    const database = scripted([artifactRecord()]);
    const files = createRunFileStore(system, database);

    await expect(files.recordArtifact(input)).resolves.toEqual(artifactRecord());

    const call = database.calls[0];

    expect(call?.text).toContain("insert into run_artifact");
    expect(call?.text).toContain("from run r where r.id = $7 and r.space_id = $1");
    expect(call?.text).toContain("on conflict (run_id, call_id) do nothing");
    expect(call?.values).toEqual([
      system.spaceId,
      "call-1",
      "report.txt",
      "text/plain",
      4,
      input.storageKey,
      "run-1",
    ]);
  });

  it("answers a replayed recording with the first row", async () => {
    const database = scripted([[], [artifactRecord()]]);
    const files = createRunFileStore(system, database);

    await expect(files.recordArtifact(input)).resolves.toEqual(artifactRecord());
    expect(database.calls).toHaveLength(2);
    expect(database.calls[1]?.text).toContain("run_id = $2 and call_id = $3");
    expect(database.calls[1]?.values).toEqual([system.spaceId, "run-1", "call-1"]);
  });

  it("reports a run outside the job's space as not-found", async () => {
    const files = createRunFileStore(system, scripted([[], []]));

    await expect(files.recordArtifact(input)).rejects.toBeInstanceOf(NotFoundError);
  });
});

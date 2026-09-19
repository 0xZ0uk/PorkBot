import { Cause, Effect, Exit, Option } from "effect";
import { ComputerEmulator } from "@porkbot/adapters";
import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";
import type { RunRecord, SystemRepositories } from "@porkbot/db";
import type { ComputerCommandRunner } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { AttachmentBytesMissingError, materializeRunAttachments } from "./run-attachments.ts";

/**
 * Materializing a message's attachments (slice 7.6, story 32). The machine is
 * the real emulator and the bytes travel through the same command writer a
 * fenced run uses; the storage seam is an in-memory provider, so the suite
 * proves the whole path — block, row, object, workspace — and reads the file
 * back out of the emulated home.
 */

const computer = { computerId: "computer-1", botId: "bot-1" };

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, Buffer>();

  async put(request: StoragePutRequest): Promise<StorageObject> {
    const chunks: Buffer[] = [];

    for await (const chunk of request.body) {
      chunks.push(Buffer.from(chunk));
    }

    const bytes = Buffer.concat(chunks);
    this.objects.set(request.key, bytes);

    return {
      key: request.key,
      size: bytes.byteLength,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      lastModified: new Date(0).toISOString(),
    };
  }

  async get(key: string): Promise<StorageBody | undefined> {
    const bytes = this.objects.get(key);

    if (bytes === undefined) {
      return undefined;
    }

    return {
      object: { key, size: bytes.byteLength, lastModified: new Date(0).toISOString() },
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  async list(): Promise<readonly StorageObject[]> {
    return [];
  }
}

function runRecord(sourceMessageId: string | null): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: computer.botId,
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "job-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(120_000),
    stopRequestedAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    currentStep: null,
    currentStepTool: null,
    stalledAt: null,
    notifiedAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function repositoriesWith(
  blocks: unknown,
  attachment: {
    readonly id: string;
    readonly storageKey: string;
  },
): SystemRepositories {
  return {
    messages: {
      append: async () => {
        throw new Error("not exercised");
      },
      findSourceForRun: async () => ({
        id: "message-1",
        threadId: "thread-1",
        seq: 0,
        role: "user" as const,
        blocks,
        runId: "run-1",
        clientNonce: "nonce-1",
        createdAt: new Date(0),
      }),
    },
    files: {
      findAttachments: async () => [
        {
          id: attachment.id,
          spaceId: "space-1",
          threadId: "thread-1",
          botId: computer.botId,
          userId: "user-1",
          filename: "report.txt",
          contentType: "text/plain",
          sizeBytes: 12,
          storageKey: attachment.storageKey,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      recordArtifact: async () => {
        throw new Error("not exercised");
      },
    },
  } as unknown as SystemRepositories;
}

function commandsFor(emulator: ComputerEmulator): ComputerCommandRunner {
  return {
    exec: (request) =>
      Effect.tryPromise({
        try: () =>
          emulator.exec({
            computer,
            command: request.command,
            timeoutMs: request.timeoutMs,
          }),
        catch: (error) => error,
      }),
  };
}

const attachment = {
  id: "41a2f8a2-4a5a-4a6e-8f3a-2f5c9d1b7e4c",
  storageKey: "files/space-1/object/report.txt",
};

describe("materializing a run's attachments", () => {
  it("streams the stored bytes into the home and answers their path", async () => {
    const emulator = new ComputerEmulator();
    await emulator.ensure(computer);
    const storage = new MemoryStorage();
    await storage.put({
      key: attachment.storageKey,
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("attachment bytes");
        },
      },
      contentType: "text/plain",
    });

    const placed = await Effect.runPromise(
      materializeRunAttachments(runRecord("message-1"), {
        computer,
        commands: commandsFor(emulator),
        repositories: repositoriesWith(
          [
            { type: "text", text: "read this" },
            {
              type: "file",
              attachmentId: attachment.id,
              filename: "report.txt",
              contentType: "text/plain",
              sizeBytes: 16,
            },
          ],
          attachment,
        ),
        storage,
      }),
    );

    expect(placed).toEqual([
      {
        attachmentId: attachment.id,
        path: `attachments/${attachment.id}/report.txt`,
        bytes: 16,
      },
    ]);

    const read = await emulator.exec({
      computer,
      command: `cat 'attachments/${attachment.id}/report.txt'`,
      timeoutMs: 2_000,
    });

    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe("attachment bytes");
  });

  it("places nothing for a routine run or a message without file blocks", async () => {
    const emulator = new ComputerEmulator();
    await emulator.ensure(computer);
    const storage = new MemoryStorage();

    await expect(
      Effect.runPromise(
        materializeRunAttachments(runRecord(null), {
          computer,
          commands: commandsFor(emulator),
          repositories: repositoriesWith([], attachment),
          storage,
        }),
      ),
    ).resolves.toEqual([]);

    await expect(
      Effect.runPromise(
        materializeRunAttachments(runRecord("message-1"), {
          computer,
          commands: commandsFor(emulator),
          repositories: repositoriesWith([{ type: "text", text: "hello" }], attachment),
          storage,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it("fails when the storage seam no longer holds the referenced bytes", async () => {
    const emulator = new ComputerEmulator();
    await emulator.ensure(computer);

    const exit = await Effect.runPromiseExit(
      materializeRunAttachments(runRecord("message-1"), {
        computer,
        commands: commandsFor(emulator),
        repositories: repositoriesWith(
          [
            {
              type: "file",
              attachmentId: attachment.id,
              filename: "report.txt",
              contentType: "text/plain",
              sizeBytes: 16,
            },
          ],
          attachment,
        ),
        storage: new MemoryStorage(),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();

    expect(Option.isSome(failure) ? failure.value : undefined).toBeInstanceOf(
      AttachmentBytesMissingError,
    );
  });
});

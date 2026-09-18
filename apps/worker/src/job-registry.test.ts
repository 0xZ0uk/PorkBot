import type { JobHelpers } from "graphile-worker";
import type { Queryable } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { JobPayloadError, createJobRegistry, defineJob } from "./job-registry.ts";
import type { JobContext } from "./job-registry.ts";

/**
 * The registry's job: one identifier per handler, a payload parser that runs
 * before the handler, and a context that carries Graphile's identity plus the
 * runner's connection. The tests drive a definition through the task list the
 * way Graphile does, so what is asserted is the boundary the runner sees.
 */

interface Recorded<Payload> {
  readonly payloads: Payload[];
  readonly contexts: JobContext[];
}

function recordingJob<Payload>(identifier: string, parse: (payload: unknown) => Payload) {
  const recorded: Recorded<Payload> = { payloads: [], contexts: [] };

  return {
    recorded,
    definition: defineJob<Payload>({
      identifier,
      parse,
      async handle(payload, context) {
        recorded.payloads.push(payload);
        recorded.contexts.push(context);
      },
    }),
  };
}

function fakeHelpers(options: { readonly jobId?: string; readonly attempts?: number } = {}) {
  const client: Queryable = {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  };

  const helpers = {
    job: {
      id: options.jobId ?? "job-1",
      attempts: options.attempts ?? 1,
      task_identifier: "example.job",
    },
    withPgClient: async <T>(work: (pgClient: Queryable) => Promise<T>): Promise<T> => work(client),
  } as unknown as JobHelpers;

  return { helpers, client };
}

function silentLogger() {
  const lines: Record<string, unknown>[] = [];

  return {
    lines,
    logger: createLogger({
      service: "@porkbot/worker",
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
}

describe("a job registry", () => {
  it("addresses every registered job by its identifier", () => {
    const first = recordingJob("first.job", (payload) => payload);
    const second = recordingJob("second.job", (payload) => payload);
    const { logger } = silentLogger();

    const registry = createJobRegistry({
      jobs: [first.definition, second.definition],
      logger,
    });

    expect(registry.identifiers).toEqual(["first.job", "second.job"]);
    expect(Object.keys(registry.taskList).sort()).toEqual(["first.job", "second.job"]);
  });

  it("refuses two handlers for one identifier", () => {
    const first = recordingJob("same.job", (payload) => payload);
    const second = recordingJob("same.job", (payload) => payload);
    const { logger } = silentLogger();

    expect(() =>
      createJobRegistry({ jobs: [first.definition, second.definition], logger }),
    ).toThrow(/registered twice/);
  });

  it("parses the payload before the handler sees it and passes Graphile's identity", async () => {
    const job = recordingJob("example.job", (payload: unknown) => {
      if (typeof payload !== "object" || payload === null || !("value" in payload)) {
        throw new JobPayloadError("example.job", "needs a value");
      }

      return (payload as { value: number }).value;
    });
    const { logger, lines } = silentLogger();
    const registry = createJobRegistry({ jobs: [job.definition], logger });
    const { helpers, client } = fakeHelpers({ jobId: "job-9", attempts: 3 });

    await registry.taskList["example.job"]?.({ value: 7 }, helpers);

    expect(job.recorded.payloads).toEqual([7]);
    expect(job.recorded.contexts[0]?.jobId).toBe("job-9");
    expect(job.recorded.contexts[0]?.attempt).toBe(3);

    await job.recorded.contexts[0]?.withPgClient(async (pgClient) => {
      expect(pgClient).toBe(client);
    });

    job.recorded.contexts[0]?.logger.info("handled");
    expect(lines.at(-1)).toMatchObject({ jobId: "job-9", task: "example.job", msg: "handled" });
  });

  it("fails the job when the payload is refused instead of calling the handler", async () => {
    const job = recordingJob("example.job", () => {
      throw new JobPayloadError("example.job", "carries work");
    });
    const { logger } = silentLogger();
    const registry = createJobRegistry({ jobs: [job.definition], logger });
    const { helpers } = fakeHelpers();

    await expect(
      registry.taskList["example.job"]?.({ prompt: "do the thing" }, helpers),
    ).rejects.toThrow(/carries work/);
    expect(job.recorded.payloads).toEqual([]);
  });
});

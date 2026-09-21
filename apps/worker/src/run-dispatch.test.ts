import type { Queryable } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import type { Runner } from "graphile-worker";
import { describe, expect, it, vi } from "vitest";
import { dispatchQueuedRunBatch, startRunDispatcher } from "./run-dispatch.ts";

const logger = createLogger({ service: "run-dispatch-test", write: () => {} });

describe("queued run dispatcher", () => {
  it("addresses every queued run with one stable Graphile job key", async () => {
    const database: Queryable = {
      async query<Row>() {
        return {
          rows: [
            { runId: "run-1", spaceId: "space-1", fence: 0 },
            { runId: "run-2", spaceId: "space-2", fence: 3 },
          ] as unknown as readonly Row[],
        };
      },
    };
    const addJob = vi.fn(async () => ({ id: "job-1" }));

    await expect(
      dispatchQueuedRunBatch({
        database,
        queue: { addJob } as unknown as Pick<Runner, "addJob">,
        logger,
      }),
    ).resolves.toBe(2);

    expect(addJob).toHaveBeenNthCalledWith(
      1,
      "run.execute",
      { runId: "run-1", fence: 0, spaceId: "space-1" },
      { jobKey: "run.execute:run-1", jobKeyMode: "replace" },
    );
    expect(addJob).toHaveBeenNthCalledWith(
      2,
      "run.execute",
      { runId: "run-2", fence: 3, spaceId: "space-2" },
      { jobKey: "run.execute:run-2", jobKeyMode: "replace" },
    );
  });

  it("waits for an active pass when stopped", async () => {
    let release: (() => void) | undefined;
    const database: Queryable = {
      query: async () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [] });
        }),
    };
    const dispatcher = startRunDispatcher({
      database,
      queue: { addJob: vi.fn() } as unknown as Pick<Runner, "addJob">,
      logger,
      intervalMs: 1,
    });
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});

import { createRepositories } from "@porkbot/db";
import { describe, expect, it } from "vitest";
import { systemActorForJob } from "./system-actor.ts";

/**
 * The worker boundary of the actor rule: a job's handler turns its payload's
 * scope into a `SystemActor` and builds repositories from it. The fake database
 * proves the repository's statements are bound to the job's space, so the
 * worker's first read cannot be widened by a handler.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface RecordingDatabase {
  readonly calls: readonly QueryCall[];
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

function recordingDatabase(): RecordingDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });

      return { rows: [] as readonly Row[] };
    },
  };
}

describe("a job's SystemActor", () => {
  it("carries the job id and the job's space", () => {
    expect(systemActorForJob({ jobId: "job-1", spaceId: "space-1" })).toEqual({
      kind: "system",
      jobId: "job-1",
      spaceId: "space-1",
    });
  });

  it("scopes a repository to the job's space", async () => {
    const database = recordingDatabase();
    const repositories = createRepositories(
      systemActorForJob({ jobId: "job-1", spaceId: "space-1" }),
      database,
    );

    await repositories.runs.findById("run-1").catch(() => undefined);

    expect(database.calls[0]?.values).toEqual(["run-1", "space-1"]);
  });
});

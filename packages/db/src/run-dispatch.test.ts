import { describe, expect, it } from "vitest";
import type { Queryable } from "./queryable.ts";
import { findQueuedRunDispatches } from "./run-dispatch.ts";

describe("queued run dispatch", () => {
  it("finds queued unowned runs from every trigger in stable order", async () => {
    const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const queued = [
      { runId: "run-message", spaceId: "space-1", fence: 0 },
      { runId: "run-routine", spaceId: "space-2", fence: 1 },
    ] as const;
    const database: Queryable = {
      async query<Row>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        return { rows: queued as unknown as readonly Row[] };
      },
    };

    await expect(findQueuedRunDispatches(database, 25)).resolves.toEqual(queued);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("status = 'queued'");
    expect(calls[0]?.text).toContain("lease_owner is null");
    expect(calls[0]?.text).not.toContain("trigger =");
    expect(calls[0]?.values).toEqual([25]);
  });
});

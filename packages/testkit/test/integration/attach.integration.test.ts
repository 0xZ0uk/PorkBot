import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  containerExists,
  removeContainer,
  startPostgresContainer,
} from "../../src/harness/docker.ts";
import type { RunningContainer } from "../../src/harness/docker.ts";
import { postgresImage, startPostgresHarness } from "../../src/harness/postgres.ts";
import type { PostgresHarness } from "../../src/harness/postgres.ts";

/**
 * Attached mode is the documented way to run the tier without booting a
 * container (TESTKIT_DATABASE_URL), so its two differences from container mode
 * are proven here: the harness clones suites on somebody else's server, and
 * `stop()` leaves that server alone because the harness did not start it.
 */

const fixturesDirectory = fileURLToPath(new URL("../fixtures/migrations", import.meta.url));

let container: RunningContainer;
let harness: PostgresHarness;

beforeAll(async () => {
  const image = (process.env["TESTKIT_POSTGRES_IMAGE"] ?? "").trim() || postgresImage;

  container = await startPostgresContainer({
    name: `porkbot-testkit-attach-${randomUUID().slice(0, 8)}`,
    image,
    user: "porkbot",
    password: "porkbot",
    database: "postgres",
  });
  harness = await startPostgresHarness({
    attachTo: `postgres://porkbot:porkbot@${container.host}:${container.port}/postgres`,
    migrationsDir: fixturesDirectory,
  });
}, 180_000);

afterAll(async () => {
  await harness?.stop();

  if (container !== undefined && (await containerExists(container.id))) {
    await removeContainer(container.id);
  }
});

describe("the harness attached to an existing server", () => {
  it("clones the migrated template for a suite on that server", async () => {
    const suite = await harness.createSuite("attached_suite");

    try {
      const client = new Client({ connectionString: suite.connectionString });

      await client.connect();

      try {
        const { rows } = await client.query<{ label: string }>(
          "select label from widgets where id = 1",
        );

        expect(rows[0]?.label).toBe("a widget from the template");
      } finally {
        await client.end();
      }
    } finally {
      await suite.destroy();
    }
  });

  it("leaves the server it did not start running when the harness stops", async () => {
    expect(harness.mode).toBe("external");
    expect(await containerExists(container.id)).toBe(true);

    await harness.stop();

    expect(await containerExists(container.id)).toBe(true);
  }, 120_000);
});

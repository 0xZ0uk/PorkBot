import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";
import {
  databaseConnections,
  pooledConnections,
  poolConnectionLimit,
} from "./connection-budget.ts";
import type { DatabasePool } from "./connection-budget.ts";

/**
 * The rule that a pool cap and the server's `max_connections` are one fact is
 * only a rule if a test reads both. This suite parses the `postgres` service in
 * `deploy/compose.yaml` — its `--setting=value` command and its memory ceiling —
 * and compares it with the budget register every `openDatabase` caller draws
 * its cap from, so moving a pool cap or the server limit alone fails by name.
 *
 * It also walks the shipped source for `new Pool(`: the two construction sites
 * that name a budget entry are the only ones allowed, so a new process cannot
 * quietly open an uncapped pool beside the budget.
 *
 * The memory settings are checked against the same ceiling: the named
 * allocations plus the two Postgres defaults they derive from (a hash node may
 * use `work_mem` twice over, and `wal_buffers` follows `shared_buffers`) must
 * still fit the 2 GB the service declares, or "the ceiling" and "the budget"
 * have become two different stories.
 *
 * The compose file is read as text, not executed: it is the deployment's
 * source of truth, and a second YAML parser here would be a second reading of
 * it.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const deployCompose = readFileSync(path.join(repoRoot, "deploy", "compose.yaml"), "utf8");

/** The settings the deployment's server must name, in the command's groups. */
const namedSettings = [
  "shared_buffers",
  "work_mem",
  "maintenance_work_mem",
  "max_connections",
  "superuser_reserved_connections",
  "autovacuum_max_workers",
  "io_method",
  "io_workers",
  "io_max_concurrency",
  "effective_io_concurrency",
  "maintenance_io_concurrency",
  "bgwriter_delay",
  "bgwriter_lru_maxpages",
  "checkpoint_timeout",
  "max_wal_size",
  "min_wal_size",
] as const;

/** The `postgres` service block, from its `  postgres:` line to the next sibling. */
function postgresBlock(): string {
  const lines = deployCompose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "  postgres:");

  if (start === -1) {
    throw new Error("deploy/compose.yaml has no postgres service");
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  const block = end === -1 ? rest : rest.slice(0, end);

  return [lines[start], ...block].join("\n");
}

/** Every `--name=value` setting on the postgres command, in file order. */
function postgresSettings(): Map<string, string> {
  const settings = new Map<string, string>();

  for (const match of postgresBlock().matchAll(/^\s+- --([a-z_]+)=(\S+)$/gm)) {
    settings.set(match[1] ?? "", match[2] ?? "");
  }

  return settings;
}

const bytesPerUnit = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const;

/** Postgres and Compose both read `kB`/`MB`/`g` as powers of two. */
function parseBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(kb|mb|gb)$/i.exec(value.trim());
  const amount = Number(match?.[1] ?? Number.NaN);
  const unit = (match?.[2] ?? "").toLowerCase() as keyof typeof bytesPerUnit;

  if (!Number.isFinite(amount) || bytesPerUnit[unit] === undefined) {
    throw new Error(`"${value}" is not a byte size this test can read`);
  }

  return amount * bytesPerUnit[unit];
}

/** The shipped TypeScript in the `src` trees under `apps` and `packages`. */
function shippedSourceFiles(): string[] {
  const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);
  const collected: string[] = [];

  function collect(directory: string): void {
    if (!existsSync(directory)) {
      return;
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) {
          collect(absolute);
        }

        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        collected.push(absolute);
      }
    }
  }

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      collect(path.join(repoRoot, group, entry.name, "src"));
    }
  }

  return collected;
}

/** The only shipped files that may construct a pool, and their budget entry. */
const poolConstructionFiles = [
  "packages/db/src/database.ts",
  "packages/db/src/migrate-cli.ts",
] as const;

describe("the deployment's connection budget", () => {
  it("parses the server's named settings from the postgres command", () => {
    const settings = postgresSettings();

    for (const name of namedSettings) {
      expect(settings.has(name), `postgres must name ${name}`).toBe(true);
    }

    // The parser itself: the block is the service's, not a neighbour's.
    expect(postgresBlock()).toContain("image: postgres:18@sha256:");
    expect(settings.get("max_connections")).toMatch(/^\d+$/);
  });

  it("caps every named pool from the register", () => {
    for (const pool of Object.keys(databaseConnections.pools) as DatabasePool[]) {
      expect(poolConnectionLimit(pool)).toBe(databaseConnections.pools[pool]);
    }
  });

  it("keeps every shipped pool on the budget", () => {
    const allowed = new Set<string>(poolConstructionFiles);
    const offenders: string[] = [];
    let constructions = 0;

    for (const file of shippedSourceFiles()) {
      const relative = path.relative(repoRoot, file);
      const source = readFileSync(file, "utf8");

      if (!source.includes("new Pool(")) {
        continue;
      }

      constructions += 1;

      if (!allowed.has(relative)) {
        offenders.push(relative);
      }
    }

    expect(
      offenders,
      "a pool outside the two construction sites has no budget cap; give it a " +
        "named pool in connection-budget.ts or extend this register deliberately",
    ).toEqual([]);

    // The invariant binds: the construction sites exist and each names a cap.
    expect(constructions).toBe(poolConstructionFiles.length);

    for (const relative of poolConstructionFiles) {
      expect(readFileSync(path.join(repoRoot, relative), "utf8")).toContain(
        "max: poolConnectionLimit(",
      );
    }
  });

  it("keeps max_connections and the pool caps in step", () => {
    const settings = postgresSettings();

    expect(Number(settings.get("max_connections"))).toBe(databaseConnections.maxConnections);
    expect(Number(settings.get("superuser_reserved_connections"))).toBe(
      databaseConnections.superuserReserved,
    );

    // The queue pool is derived from the job concurrency, not inherited from
    // the driver's default of ten: four jobs and two connections of queue
    // bookkeeping.
    expect(databaseConnections.pools.workerQueue).toBe(
      databaseConnections.workerJobConcurrency + 2,
    );
  });

  it("states headroom that the pools plus the reserve add up to", () => {
    const named = `pools=${JSON.stringify(databaseConnections.pools)}`;

    expect(
      pooledConnections() + databaseConnections.superuserReserved + databaseConnections.headroom,
      named,
    ).toBe(databaseConnections.maxConnections);

    expect(pooledConnections(), named).toBeLessThanOrEqual(
      databaseConnections.maxConnections - databaseConnections.superuserReserved,
    );
  });

  it("fits the named memory settings inside the postgres ceiling", () => {
    const settings = postgresSettings();
    const block = postgresBlock();
    const ceiling = /memory:\s*(\d+(?:\.\d+)?)([mg])\b/.exec(block);

    expect(ceiling, "postgres must declare a memory ceiling").not.toBeNull();

    const ceilingBytes = parseBytes(`${ceiling?.[1] ?? ""}${ceiling?.[2] ?? ""}b`);
    const sharedBuffers = parseBytes(settings.get("shared_buffers") ?? "");
    const workMem = parseBytes(settings.get("work_mem") ?? "");
    const maintenanceWorkMem = parseBytes(settings.get("maintenance_work_mem") ?? "");
    const maxConnections = Number(settings.get("max_connections") ?? "");
    const autovacuumWorkers = Number(settings.get("autovacuum_max_workers") ?? "");

    // The two Postgres defaults the settings derive from: a hash node may use
    // `work_mem` times `hash_mem_multiplier` (2.0), and `wal_buffers` follows
    // `shared_buffers` when it is left to `-1`.
    const hashMemMultiplier = 2;
    const walBuffers = sharedBuffers / 32;

    const worstCase =
      sharedBuffers +
      walBuffers +
      workMem * maxConnections * hashMemMultiplier +
      maintenanceWorkMem * autovacuumWorkers;

    expect(worstCase).toBeLessThanOrEqual(ceilingBytes);
  });
});

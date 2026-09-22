import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  builtServiceImages,
  imageBudgetsFilePath,
  parseBudgetsValue,
  readBudgets,
} from "../src/image-sizes/budgets.ts";
import type { ImageBudget } from "../src/image-sizes/budgets.ts";
import {
  bytesToMiB,
  formatVerdictTable,
  judgeImage,
  verdictFailures,
} from "../src/image-sizes/measure.ts";
import { findRepoRoot } from "../src/paths.ts";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const deployComposeText = readFileSync(path.join(repoRoot, "deploy", "compose.yaml"), "utf8");
const dockerfileText = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

function budget(overrides: Partial<ImageBudget> = {}): ImageBudget {
  return {
    name: "porkbot/api",
    budgetMiB: 100,
    reason: "The measured size was 80 MiB.",
    ...overrides,
  };
}

describe("image budget register", () => {
  it("accepts a register of named ceilings with reasons", () => {
    const { register, errors } = parseBudgetsValue({
      version: 1,
      images: [budget(), budget({ name: "porkbot/worker", budgetMiB: 200 })],
    });

    expect(errors).toEqual([]);
    expect(register.images.map((entry) => entry.name)).toEqual(["porkbot/api", "porkbot/worker"]);
  });

  it("refuses an unversioned register, a non-array and a duplicate name", () => {
    expect(parseBudgetsValue({ version: 2, images: [] }).errors[0]).toContain(
      '"version" must be 1',
    );
    expect(parseBudgetsValue({ version: 1, images: {} }).errors[0]).toContain(
      '"images" must be an array',
    );

    const duplicate = parseBudgetsValue({ version: 1, images: [budget(), budget()] });
    expect(duplicate.errors.join("\n")).toContain("twice");
  });

  it("refuses a missing field, a non-integer ceiling and a reason too short to review", () => {
    const missing = parseBudgetsValue({
      version: 1,
      images: [{ name: "porkbot/api", budgetMiB: 1 }],
    });
    expect(missing.errors[0]).toContain("reason");

    const fractional = parseBudgetsValue({ version: 1, images: [budget({ budgetMiB: 10.5 })] });
    expect(fractional.errors.join("\n")).toContain("positive whole number");

    const negative = parseBudgetsValue({ version: 1, images: [budget({ budgetMiB: -5 })] });
    expect(negative.errors.join("\n")).toContain("positive whole number");

    const short = parseBudgetsValue({ version: 1, images: [budget({ reason: "too small" })] });
    expect(short.errors.join("\n")).toContain("too short to review");
  });

  it("reads the repository's register without errors", () => {
    const { errors } = readBudgets(imageBudgetsFilePath(repoRoot));

    expect(errors).toEqual([]);
  });

  it("treats a missing file as an error rather than an empty register", () => {
    const { errors } = readBudgets(path.join(repoRoot, "no-such-image-budgets.json"));

    expect(errors[0]).toContain("is missing");
  });
});

describe("the built services and their budgets", () => {
  it("finds every deploy compose service that builds a Dockerfile target", () => {
    const built = builtServiceImages(deployComposeText);

    expect(built.map((image) => image.service).sort()).toEqual([
      "api",
      "backup",
      "migrate",
      "proxy",
      "supervisor",
      "worker",
    ]);
    expect(built.map((image) => image.name)).toContain("porkbot/api");
  });

  it("gives every built image a budget, and every budget an image to measure", () => {
    const { register, errors } = readBudgets(imageBudgetsFilePath(repoRoot));
    const built = builtServiceImages(deployComposeText)
      .map((image) => image.name)
      .sort();
    const budgeted = register.images.map((entry) => entry.name).sort();

    expect(errors).toEqual([]);
    expect(budgeted).toEqual(built);
  });

  it("keeps the backup image on the Node runtime with Postgres clients, not a server", () => {
    // The rule the size budget protects: the backup image carries `pg_dump`
    // and `pg_restore`, and the Postgres image is where they are copied from —
    // never the base a service image is built on.
    const stages = dockerfileText.split(/^(?=FROM )/m);
    const backupStage = stages.find((stage) =>
      /^FROM \S+ AS backup$/m.test(stage.split("\n")[0] ?? ""),
    );
    const pgClientStage = stages.find((stage) =>
      /^FROM \S+ AS pg-client$/m.test(stage.split("\n")[0] ?? ""),
    );

    expect(backupStage, "the Dockerfile must keep a backup stage").toBeDefined();
    expect(pgClientStage, "the Postgres clients need their own source stage").toBeDefined();
    expect(backupStage).toMatch(/^FROM node:\S+ AS backup$/m);
    expect(backupStage).toContain("COPY --from=pg-client /usr/lib/postgresql/18/bin/pg_dump");
    expect(backupStage).toContain("pg_dump --version && pg_restore --version");
    expect(backupStage).not.toMatch(/^FROM postgres:/m);
    expect(pgClientStage).toMatch(/^FROM postgres:18@sha256:/m);
  });
});

describe("judging a measurement against its budget", () => {
  it("stays within budget and reports the headroom in whole MiB", () => {
    const verdict = judgeImage(budget({ budgetMiB: 100 }), 80 * 1024 * 1024);

    expect(verdict.status).toBe("within");
    expect(verdict.headroomMiB).toBe(20);
    expect(verdictFailures([verdict])).toEqual([]);
  });

  it("rounds a partial MiB up so a budget cannot be beaten by a byte", () => {
    const verdict = judgeImage(budget({ budgetMiB: 100 }), 100 * 1024 * 1024 + 1);

    expect(verdict.status).toBe("over");
    expect(verdict.headroomMiB).toBe(-1);
  });

  it("reports an image past its ceiling as a failure that names the file to edit", () => {
    const verdict = judgeImage(budget({ budgetMiB: 100 }), 120 * 1024 * 1024);
    const failures = verdictFailures([verdict]);

    expect(verdict.status).toBe("over");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("porkbot/api");
    expect(failures[0]).toContain("image-budgets.json");
  });

  it("reports an unbuilt image as a failure rather than passing it silently", () => {
    const verdict = judgeImage(budget(), null);

    expect(verdict.status).toBe("missing");
    expect(verdictFailures([verdict])[0]).toContain("is not built");
  });

  it("renders the table the job summary reads", () => {
    const table = formatVerdictTable([
      judgeImage(budget({ budgetMiB: 100 }), 80 * 1024 * 1024),
      judgeImage(budget({ name: "porkbot/worker", budgetMiB: 50 }), 60 * 1024 * 1024),
      judgeImage(budget({ name: "porkbot/backup", budgetMiB: 50 }), null),
    ]);

    expect(table).toContain("| image | measured | budget | headroom |");
    expect(table).toContain("| `porkbot/api` | 80 MiB | 100 MiB | 20 MiB |");
    expect(table).toContain("| `porkbot/worker` | 60 MiB | 50 MiB | -10 MiB over |");
    expect(table).toContain("| `porkbot/backup` | not built | 50 MiB | — |");
  });

  it("converts bytes to MiB at 1024 squared", () => {
    expect(bytesToMiB(1024 * 1024)).toBe(1);
  });
});

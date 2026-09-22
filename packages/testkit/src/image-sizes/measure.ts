import type { ImageBudget } from "./budgets.ts";

/**
 * Measuring a built image and judging it against its budget. The Docker call
 * is a parameter, so the judgement below is unit-tested with numbers and no
 * daemon; only `readImageSize` shells out.
 */

/** How a measured size relates to the stated ceiling. */
export interface BudgetVerdict {
  /** The built image's name without a tag, e.g. `porkbot/api`. */
  readonly name: string;
  /** The ceiling in whole MiB. */
  readonly budgetMiB: number;
  /** The measured size in bytes, or null when the image is not built. */
  readonly measuredBytes: number | null;
  readonly status: "within" | "over" | "missing";
  /** Budget minus measurement in whole MiB; negative when over. */
  readonly headroomMiB: number | null;
}

export type CommandRunner = (command: string, args: readonly string[]) => string;

const bytesPerMiB = 1024 * 1024;

export function bytesToMiB(bytes: number): number {
  return bytes / bytesPerMiB;
}

/** `docker image inspect` for one image; null when it is not built. */
export function readImageSize(name: string, tag: string, run: CommandRunner): number | null {
  try {
    const raw = run("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Size}}",
      `${name}:${tag}`,
    ]).trim();
    const bytes = Number(raw);

    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export function judgeImage(budget: ImageBudget, measuredBytes: number | null): BudgetVerdict {
  if (measuredBytes === null) {
    return {
      name: budget.name,
      budgetMiB: budget.budgetMiB,
      measuredBytes: null,
      status: "missing",
      headroomMiB: null,
    };
  }

  const measuredMiB = Math.ceil(bytesToMiB(measuredBytes));
  const headroomMiB = budget.budgetMiB - measuredMiB;

  return {
    name: budget.name,
    budgetMiB: budget.budgetMiB,
    measuredBytes,
    status: headroomMiB >= 0 ? "within" : "over",
    headroomMiB,
  };
}

/** The failures behind a set of verdicts, in words a step log can act on. */
export function verdictFailures(verdicts: readonly BudgetVerdict[]): string[] {
  const failures: string[] = [];

  for (const verdict of verdicts) {
    if (verdict.status === "missing") {
      failures.push(
        `${verdict.name} is not built under the measured tag; build it (pnpm stack:up builds ` +
          "every service image) before measuring, because an unbuilt image has no size to check.",
      );
    } else if (verdict.status === "over") {
      failures.push(
        `${verdict.name} is ${Math.ceil(bytesToMiB(verdict.measuredBytes ?? 0))} MiB, past its ` +
          `${verdict.budgetMiB} MiB budget by ${-(verdict.headroomMiB ?? 0)} MiB. Shrink the ` +
          `image or raise the budget in ${"image-budgets.json"} with a reason in the same diff.`,
      );
    }
  }

  return failures;
}

/** The markdown table the job summary and the PR read. */
export function formatVerdictTable(verdicts: readonly BudgetVerdict[]): string {
  const rows = verdicts.map((verdict) => {
    const measured =
      verdict.measuredBytes === null
        ? "not built"
        : `${Math.ceil(bytesToMiB(verdict.measuredBytes))} MiB`;
    const headroom =
      verdict.headroomMiB === null
        ? "—"
        : verdict.headroomMiB >= 0
          ? `${verdict.headroomMiB} MiB`
          : `${verdict.headroomMiB} MiB over`;

    return `| \`${verdict.name}\` | ${measured} | ${verdict.budgetMiB} MiB | ${headroom} |`;
  });

  return ["| image | measured | budget | headroom |", "| --- | ---: | ---: | ---: |", ...rows].join(
    "\n",
  );
}

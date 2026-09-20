#!/usr/bin/env node
import process from "node:process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { ComputerProvider } from "@porkbot/adapter-kit";
import { createSupervisorComputerProvider } from "@porkbot/adapters";
import type { SupervisorComputerProvider } from "@porkbot/adapters";
import { resolveCanaryNotificationTarget } from "./notify.ts";
import { CANARY_RUNS_PER_MONTH, formatDurationMs, formatUsd } from "./policy.ts";
import { runCanary, sweepCanary } from "./runner.ts";
import type { CanaryLogger, CanaryNotifier, CanaryReport } from "./runner.ts";

/**
 * The canary CLI (slice 12.6), driven by the nightly workflow and usable by an
 * operator against any deployment's supervisor.
 *
 *   run     one canary per requested provider kind through the supervisor:
 *           sweep leftovers, boot, run, tool call, teardown, verify
 *   sweep   destroy every machine a previous canary run left behind
 *   notify  deliver one operator notification through the E8 provider
 *
 * Every decision the runner makes is environment-injected — the supervisor's
 * URL and token, the webhook the failure notification uses — so a test drives
 * the whole CLI without a daemon, a key or a network. The runner itself takes
 * the provider seam, so the unit tier runs this against the offline emulator
 * and the integration tier runs it against real Docker.
 */

export interface CanaryCliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Injected by tests; production builds the supervisor client from the environment. */
  readonly provider?: ComputerProvider | undefined;
  readonly notifier?: CanaryNotifier | undefined;
  readonly logger?: CanaryLogger | undefined;
  readonly now?: (() => number) | undefined;
  readonly runId?: (() => string) | undefined;
}

interface ParsedArguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly help: boolean;
}

export function usage(): string {
  return [
    "Usage: canary <command> [options]",
    "",
    "Commands:",
    "  run      Run the live-provider canary for one or more provider kinds.",
    "  sweep    Destroy machines a previous canary run left behind.",
    "  notify   Deliver one operator notification through the E8 provider.",
    "  help     This text.",
    "",
    "Options for `run`:",
    "  --kind <kind>              Provider kind to exercise; repeatable (default: the supervisor's default).",
    "  --billable <kind|all>      A kind that spends money; repeatable. Billable kinds need a stated budget.",
    "  --budget-usd <n>           The stated monthly budget the per-run ceiling is derived from.",
    "  --usd-per-minute <n>       The provider's stated rate, in US dollars per machine-minute.",
    "  --logs-url <url>           The link a failure notification carries (the run's logs).",
    "  --workdir <path>           Where the canary token is written (default: /home/agent).",
    "  --default-ceiling-ms <n>   The ceiling for kinds that are not billed (default: 300000).",
    "  --request-timeout-ms <n>   The supervisor transport budget per call (default: 120000).",
    "  --notify-on-failure        Deliver the failure through the E8 provider from this process.",
    "  --report <path>            Also write the JSON report to this file.",
    "",
    "Options for `sweep`:",
    "  --request-timeout-ms <n>   The supervisor transport budget per call (default: 120000).",
    "",
    "Options for `notify`:",
    "  --title <text>             The notification title (required).",
    "  --body <text>              One paragraph an operator can read (required).",
    "  --url <url>                An optional link into the surface that owns the event.",
    "",
    "Environment:",
    "  PORKBOT_SUPERVISOR_URL       The supervisor's origin, for the run and sweep commands.",
    "  PORKBOT_SUPERVISOR_TOKEN     The supervisor's process credential. Never logged.",
    `  PORKBOT_NOTIFICATION_WEBHOOK_URL   Where a failure notification is delivered; unset keeps it on the error log.`,
    "",
    `The cloud canary's budget: per-run ceiling = monthly budget / (rate x ${String(CANARY_RUNS_PER_MONTH)} nights).`,
  ].join("\n");
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags = new Map<string, string[]>();
  let help = false;

  if (argv.length === 0) {
    return { command: "", flags, help: false };
  }

  const command = argv[0] ?? "";

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";

    if (token === "--help" || token === "-h" || token === "help") {
      help = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument "${token}"`);
    }

    const [name, inline] = token.slice(2).split("=", 2);
    const key = name ?? "";

    if (inline !== undefined) {
      flags.set(key, [...(flags.get(key) ?? []), inline]);
      continue;
    }

    const next = argv[index + 1];

    if (next === undefined || next.startsWith("--")) {
      flags.set(key, [...(flags.get(key) ?? []), "true"]);
      continue;
    }

    flags.set(key, [...(flags.get(key) ?? []), next]);
    index += 1;
  }

  return { command, flags, help };
}

function single(flags: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  const values = flags.get(name);

  if (values === undefined) {
    return undefined;
  }

  if (values.length > 1) {
    throw new Error(`--${name} was given more than once`);
  }

  return values[0];
}

function repeated(flags: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] {
  return flags.get(name) ?? [];
}

function numberFlag(
  flags: ReadonlyMap<string, readonly string[]>,
  name: string,
): number | undefined {
  const value = single(flags, name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} is not a number`);
  }

  return parsed;
}

function cliLogger(err: (line: string) => void): CanaryLogger {
  function write(level: string) {
    return (message: string, fields?: Record<string, unknown>): void => {
      err(JSON.stringify({ level, message, ...(fields ?? {}) }));
    };
  }

  return { info: write("info"), warn: write("warn"), error: write("error") };
}

function hasProviderCatalog(provider: ComputerProvider): provider is SupervisorComputerProvider {
  return typeof (provider as { readonly providers?: unknown }).providers === "function";
}

/** The provider the run and sweep commands drive: injected, or the supervisor client. */
function resolveProvider(context: CanaryCliContext, requestTimeoutMs: number): ComputerProvider {
  if (context.provider !== undefined) {
    return context.provider;
  }

  const baseUrl = context.env["PORKBOT_SUPERVISOR_URL"]?.trim() ?? "";
  const token = context.env["PORKBOT_SUPERVISOR_TOKEN"]?.trim() ?? "";

  if (baseUrl === "" || token === "") {
    throw new Error(
      "PORKBOT_SUPERVISOR_URL and PORKBOT_SUPERVISOR_TOKEN are required to reach the supervisor",
    );
  }

  return createSupervisorComputerProvider({ baseUrl, token, requestTimeoutMs });
}

function reportLines(reports: readonly CanaryReport[]): string[] {
  return reports.map((report) => {
    const budget =
      report.budget?.kind === "ready"
        ? `, ceiling ${formatDurationMs(report.budget.perRunCeilingMs ?? 0)}`
        : "";
    const cost =
      report.estimatedCostUsd === undefined ? "" : `, spend ${formatUsd(report.estimatedCostUsd)}`;
    const skipped = report.skipReason === undefined ? "" : ` (${report.skipReason})`;

    return `${report.status}${skipped}: ${report.kind}, ${formatDurationMs(report.durationMs)}${budget}${cost}`;
  });
}

async function runCommand(
  parsed: ParsedArguments,
  context: CanaryCliContext,
  logger: CanaryLogger,
): Promise<number> {
  const requestTimeoutMs = numberFlag(parsed.flags, "request-timeout-ms") ?? 120_000;
  const provider = resolveProvider(context, requestTimeoutMs);
  const requestedKinds = repeated(parsed.flags, "kind");
  const billable = repeated(parsed.flags, "billable");
  const logsUrl = single(parsed.flags, "logs-url");
  const workdir = single(parsed.flags, "workdir");
  const defaultCeilingMs = numberFlag(parsed.flags, "default-ceiling-ms");
  const notifyOnFailure = single(parsed.flags, "notify-on-failure") === "true";
  const notifier = notifyOnFailure
    ? (context.notifier ?? resolveCanaryNotificationTarget(context.env, logger).provider)
    : context.notifier;

  let kinds = requestedKinds;

  if (kinds.length === 0) {
    if (!hasProviderCatalog(provider)) {
      throw new Error("--kind is required when the provider has no configured-kind catalog");
    }

    const catalog = await provider.providers();
    kinds = [catalog.defaultKind];
  }

  const reports: CanaryReport[] = [];

  for (const kind of kinds) {
    reports.push(
      await runCanary({
        provider,
        kind,
        billable: billable.includes(kind) || billable.includes("all"),
        monthlyBudgetUsd: numberFlag(parsed.flags, "budget-usd"),
        usdPerMinute: numberFlag(parsed.flags, "usd-per-minute"),
        logsUrl,
        workdir,
        notifier,
        logger,
        defaultCeilingMs,
        now: context.now,
        runId: context.runId?.(),
      }),
    );
  }

  const reportPath = single(parsed.flags, "report");
  const payload = JSON.stringify({ reports }, null, 2);

  if (reportPath !== undefined) {
    writeFileSync(reportPath, `${payload}\n`);
  }

  context.out(payload);

  for (const line of reportLines(reports)) {
    logger.info(line, {});
  }

  return reports.some((report) => report.status === "failed") ? 1 : 0;
}

async function sweepCommand(
  parsed: ParsedArguments,
  context: CanaryCliContext,
  logger: CanaryLogger,
): Promise<number> {
  const requestTimeoutMs = numberFlag(parsed.flags, "request-timeout-ms") ?? 120_000;
  const provider = resolveProvider(context, requestTimeoutMs);
  const swept = await sweepCanary(provider, logger);
  const payload = JSON.stringify(
    {
      removed: swept.removed.map((computer) => computer.computerId),
      failed: swept.failed.map((entry) => ({
        computerId: entry.computer.computerId,
        detail: entry.detail,
      })),
    },
    null,
    2,
  );
  const reportPath = single(parsed.flags, "report");

  if (reportPath !== undefined) {
    writeFileSync(reportPath, `${payload}\n`);
  }

  context.out(payload);

  return swept.failed.length === 0 ? 0 : 1;
}

async function notifyCommand(
  parsed: ParsedArguments,
  context: CanaryCliContext,
  logger: CanaryLogger,
): Promise<number> {
  const title = single(parsed.flags, "title");
  const body = single(parsed.flags, "body");
  const url = single(parsed.flags, "url");

  if (title === undefined || body === undefined) {
    throw new Error("--title and --body are required");
  }

  const target = context.notifier ?? resolveCanaryNotificationTarget(context.env, logger).provider;

  await target.deliver({ title, body, ...(url === undefined ? {} : { url }) });
  context.out(JSON.stringify({ delivered: true }, null, 2));

  return 0;
}

/** One CLI invocation; the process wrapper below is the only other caller. */
export async function runCanaryCli(
  argv: readonly string[],
  context: CanaryCliContext,
): Promise<number> {
  const logger = context.logger ?? cliLogger(context.err);

  try {
    const parsed = parseArguments(argv);

    if (parsed.command === "" || parsed.command === "help" || parsed.help) {
      context.out(usage());
      return 0;
    }

    switch (parsed.command) {
      case "run":
        return await runCommand(parsed, context, logger);
      case "sweep":
        return await sweepCommand(parsed, context, logger);
      case "notify":
        return await notifyCommand(parsed, context, logger);
      default:
        throw new Error(`unknown command "${parsed.command}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.err(message);

    return 1;
  }
}

const invoked = process.argv[1];

if (invoked !== undefined && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  process.exitCode = await runCanaryCli(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

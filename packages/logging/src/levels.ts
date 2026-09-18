/**
 * Log levels, ordered from most to least verbose. A logger emits a record when
 * the record's level is at or above the logger's threshold.
 */
export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

/** The environment variable that selects the level. */
export const logLevelEnvVar = "LOG_LEVEL";

/**
 * Production-safe default. `debug` is noise in a running deployment, and
 * `warn`/`error` would hide the request and run lifecycle the operator needs to
 * debug a running agent (PRD story 6); `info` is the smallest level that still
 * shows what a healthy process is doing.
 */
export const defaultLogLevel: LogLevel = "info";

const severity: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (logLevels as readonly string[]).includes(value);
}

/**
 * Parses a configured level. An unset (or blank) value is the default. An
 * unknown value throws instead of falling back: a typo in `LOG_LEVEL` is a
 * misconfiguration the process should refuse to start with, not a surprise
 * discovered from missing logs in production.
 */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value.trim() === "") {
    return defaultLogLevel;
  }

  const normalized = value.trim().toLowerCase();
  if (!isLogLevel(normalized)) {
    throw new Error(
      `Invalid ${logLevelEnvVar} ${JSON.stringify(value)}: expected one of ${logLevels.join(", ")}.`,
    );
  }

  return normalized;
}

/** Resolves the level from an environment map, defaulting to `info`. */
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  return parseLogLevel(env[logLevelEnvVar]);
}

/** Whether a record at `level` passes a logger configured with `threshold`. */
export function levelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return severity[level] >= severity[threshold];
}

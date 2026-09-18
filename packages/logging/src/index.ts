export const moduleInfo = {
  name: "@porkbot/logging",
  summary: "Structured JSON logging, levels, correlation ids and redaction.",
} as const;

export {
  defaultLogLevel,
  isLogLevel,
  levelEnabled,
  logLevelEnvVar,
  logLevels,
  parseLogLevel,
  resolveLogLevel,
} from "./levels.ts";
export type { LogLevel } from "./levels.ts";
export {
  circularPlaceholder,
  isSensitiveFieldName,
  isUnredacted,
  maxRedactDepth,
  redact,
  redactPath,
  redactRecord,
  redactString,
  redactedPlaceholder,
  sensitiveFieldNames,
  truncatedPlaceholder,
  unredacted,
} from "./redact.ts";
export type { SensitiveFieldName, Unredacted } from "./redact.ts";
export { createLogger } from "./logger.ts";
export type { LogContext, LogFields, Logger, LoggerOptions, RequestLogFields } from "./logger.ts";

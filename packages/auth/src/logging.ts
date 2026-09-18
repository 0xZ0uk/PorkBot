import type { Logger } from "@porkbot/logging";

/**
 * Better Auth's logger interface, structurally.
 *
 * The library writes to the console by default; passing its log lines through
 * `@porkbot/logging` instead means the redaction helper sees them. That matters
 * here rather than in the abstract: Better Auth logs hook failures and schema
 * warnings, and a hook failure can carry a rejected signup address. The
 * structural type keeps the library's own `Logger` out of this package's
 * imports, so the adapter is testable without constructing an auth instance.
 */

export type AuthLogLevel = "debug" | "info" | "warn" | "error";

export interface AuthLogger {
  readonly disabled?: boolean;
  readonly disableColors?: boolean;
  readonly level?: AuthLogLevel;
  readonly log?: (level: AuthLogLevel, message: string, ...args: unknown[]) => void;
}

export function authLogger(logger: Logger): AuthLogger {
  return {
    disabled: false,
    disableColors: true,
    level: logger.level,
    log(level: AuthLogLevel, message: string, ...args: unknown[]): void {
      const fields = args.length === 0 ? undefined : { args };

      switch (level) {
        case "debug":
          logger.debug(message, fields);
          break;
        case "warn":
          logger.warn(message, fields);
          break;
        case "error":
          logger.error(message, fields);
          break;
        default:
          logger.info(message, fields);
          break;
      }
    },
  };
}

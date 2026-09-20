import { Logger as GraphileLogger } from "graphile-worker";
import type { Logger } from "@porkbot/logging";

/**
 * Graphile's log lines, written by `@porkbot/logging`.
 *
 * `packages/logging` is the only writer of logs (the Logging section of
 * `docs/architecture/development.md`): it produces
 * one redacted JSON object per line, and nothing else in the workspace calls
 * `console`. Graphile Worker otherwise defaults to the console, so its runner
 * gets a `Logger` whose factory folds Graphile's scope — worker id, task,
 * job id — into a child of the process logger. A job's lines then carry the
 * `jobId` and, once a handler adds `runId`, the same `correlationId` the API
 * logs with.
 */
export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => {
    const scoped = logger.child({
      ...(scope.workerId === undefined ? {} : { workerId: scope.workerId }),
      ...(scope.taskIdentifier === undefined ? {} : { task: scope.taskIdentifier }),
      ...(scope.jobId === undefined ? {} : { jobId: scope.jobId }),
    });

    return (level, message, meta) => {
      const fields = { ...meta };

      switch (level) {
        case "error":
          scoped.error(message, fields);
          break;
        case "warning":
          scoped.warn(message, fields);
          break;
        case "info":
          scoped.info(message, fields);
          break;
        case "debug":
          scoped.debug(message, fields);
          break;
      }
    };
  });
}

import { createLogger, redactedPlaceholder } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { authLogger } from "./logging.ts";

function recordingLogger(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const log = createLogger({
    level: "debug",
    service: "auth-test",
    write: (line) => lines.push(line),
  });

  return { lines, log };
}

describe("authLogger", () => {
  it("routes the library's levels onto the structured logger", () => {
    const { lines, log } = recordingLogger();
    const adapter = authLogger(log);

    adapter.log?.("debug", "debug line");
    adapter.log?.("info", "info line");
    adapter.log?.("warn", "warn line");
    adapter.log?.("error", "error line");

    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("passes the library's arguments through redaction, so a secret in a log line does not survive", () => {
    const { lines, log } = recordingLogger();
    const adapter = authLogger(log);

    adapter.log?.("error", "validateUserInfo callback threw", { password: "hunter2" });

    const [line] = lines;

    expect(line).toContain(redactedPlaceholder);
    expect(line).not.toContain("hunter2");
  });
});
